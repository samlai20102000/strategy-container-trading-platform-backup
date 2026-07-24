/**
 * 策略狀態持久化管理器 - V3.5
 * 依據 Pasted_content_17.txt 要求：狀態存 DB（strategies.martinState JSON 欄位擴展），
 * 服務重啟後自動恢復，並可與交易所對賬。
 */

import type { Strategy } from "../../drizzle/schema";
import { updateStrategyMartinState, getStrategyById } from "../db";
import type { StrategyState } from "../strategies/base";
import { createInitialStrategyState } from "../strategies/base";
import type { ExchangeAdapter } from "../exchanges/types";
import { pickStrategyConfigState } from "./strategySnapshotConfig";

/**
 * 從策略記錄載入 V3.5 完整狀態
 * 相容舊版 MartinState（僅 lossCount/currentLot/lastEntryPrice）：自動遷移為 V3.5 結構
 */
export function loadStrategyState(strategy: Strategy): StrategyState {
  const raw = strategy.martinState as Record<string, unknown> | null;
  if (raw && typeof raw === "object" && typeof raw.currentLayer === "number") {
    // 已是 V3.5 結構
    return { ...createInitialStrategyState(), ...(raw as Partial<StrategyState>) } as StrategyState;
  }
  // 舊版或空狀態 → 初始化
  return createInitialStrategyState();
}

/**
 * 保存 V3.5 狀態到 DB（寫入 strategies.martinState JSON 欄位）
 * 保留已存在的所有策略配置與快照來源子鍵（所有 __* 欄位）
 */
export async function saveStrategyState(strategyId: number, state: StrategyState): Promise<void> {
  // 先讀取現有 martinState 以保留配置子鍵
  const strategy = await getStrategyById(strategyId);
  const existing = (strategy?.martinState && typeof strategy.martinState === 'object')
    ? strategy.martinState as Record<string, unknown>
    : {};
  
  // 通用保留規則：未來策略新增 __customConfig 等欄位時毋須再改此處。
  const preserved = pickStrategyConfigState(existing);

  const merged = { ...preserved, ...(state as unknown as Record<string, unknown>) };
  await updateStrategyMartinState(strategyId, merged as unknown as {
    lossCount: number;
    currentLot: number;
    lastEntryPrice: number;
  });
}

/**
 * 重置策略狀態（保留冷卻與 Bar-Lock 資訊可選）
 */
export async function resetStrategyState(strategyId: number): Promise<StrategyState> {
  const initial = createInitialStrategyState();
  await saveStrategyState(strategyId, initial);
  return initial;
}

/**
 * 與交易所對賬（信任本地記錄版）：
 * 
 * 核心原則：本地 martinState 是唯一真相來源。
 * 每次下單成功後都會精確更新本地狀態，因此本地記錄是最準確的。
 * 
 * reconcile 只在以下明確場景才介入：
 * 情境 1：交易所完全無任何持倉（含多空雙向，size全都=0）但本地有 → 外部平倉，重置本地（保留 cooldown）
 * 情境 2：交易所有持倉，本地也有（totalSize > 0）→ 完全信任本地（含方向），不修正任何欄位
 * 情境 3：交易所有持倉，本地無（totalSize=0, currentLayer=0）→ 只記錄日誌，不自動恢復（避免干擾其他策略）
 * 情境 4：本地 currentLayer=0 但 totalSize > 0 → 修正 currentLayer=1
 * 其他：信任本地記錄，不做修正
 * 
 * **不再使用減法推算**（`exchangeTotalSize - otherStrategiesTotalSize`），
 * 因為多策略共享帳戶時減法會互相干擾，導致持倉歸屬錯誤。
 */
export async function reconcileWithExchange(
  strategyId: number,
  adapter: ExchangeAdapter,
): Promise<{
  matched: boolean;
  corrections: string[];
  localState: StrategyState;
}> {
  const strategy = await getStrategyById(strategyId);
  if (!strategy) throw new Error(`策略 ${strategyId} 不存在`);

  const localState = loadStrategyState(strategy);
  const corrections: string[] = [];

  try {
    const positions = await adapter.getPositions(strategy.symbol);
    
    // ─── 方向感知持倉匹配（多策略共用帳戶核心修復） ───
    // 確定本策略期望的方向
    const expectedSide = localState.isLong ? 'long' : 'short';
    
    // 先找本策略對應方向的持倉
    const myDirectionPos = positions.find((p) => p.size > 0 && p.side === expectedSide);
    // 再看帳戶中是否有任何持倉（含其他方向/其他策略）
    const hasAnyPosition = positions.some((p) => p.size > 0);
    // 向後相容：取任意有持倉的作為 pos
    const pos = myDirectionPos || positions.find((p) => p.size > 0);

    console.log(`[Reconcile] 策略 ${strategyId} | 本地方向: ${expectedSide} | 對應方向持倉: ${myDirectionPos ? `${myDirectionPos.size} @ ${myDirectionPos.entryPrice}` : '無'} | 帳戶總持倉數=${positions.filter(p => p.size > 0).length} | 本地: layer=${localState.currentLayer} size=${localState.totalSize}`);

    // ─── 情境 1：交易所完全無任何持倉但本地有 → 外部平倉，重置本地 ───
    if (!hasAnyPosition && localState.totalSize > 0) {
      corrections.push(
        `交易所無持倉但本地記錄 ${localState.totalSize}，判定為外部平倉，重置本地狀態（含清除 Bar-Lock）`,
      );
      const reset = createInitialStrategyState();
      reset.isCooldown = localState.isCooldown;
      reset.cooldownUntil = localState.cooldownUntil;
      await saveStrategyState(strategyId, reset);
      try {
        const { releaseAllLocks } = await import("./barLock");
        await releaseAllLocks(strategyId);
        corrections.push(`已清除該策略所有 Bar-Lock 記錄`);
      } catch (e: any) {
        console.warn(`[Reconcile] 清除 Bar-Lock 失敗：${e.message}`);
      }
      return { matched: false, corrections, localState: reset };
    }

    // ─── 情境 1.5（核心修復）：帳戶有持倉但本策略對應方向無持倉 ───
    // 場景：多策略共用帳戶，其他策略平倉時把本策略的持倉也平了
    // 例如：V5.0 平空倉時把 V6.1 的多倉也平了，帳戶中只剩 ETH 持倉
    if (hasAnyPosition && !myDirectionPos && localState.totalSize > 0) {
      corrections.push(
        `帳戶有持倉但本策略對應方向(${expectedSide})無持倉，判定為被外部平倉，重置本地狀態`,
      );
      console.log(`[Reconcile] 策略 ${strategyId} 帳戶有持倉但本策略方向(${expectedSide})無持倉，重置本地狀態（可能被其他策略平倉操作影響）`);
      const reset = createInitialStrategyState();
      reset.isCooldown = localState.isCooldown;
      reset.cooldownUntil = localState.cooldownUntil;
      await saveStrategyState(strategyId, reset);
      try {
        const { releaseAllLocks } = await import("./barLock");
        await releaseAllLocks(strategyId);
        corrections.push(`已清除該策略所有 Bar-Lock 記錄`);
      } catch (e: any) {
        console.warn(`[Reconcile] 清除 Bar-Lock 失敗：${e.message}`);
      }
      return { matched: false, corrections, localState: reset };
    }

    // ─── 情境 2：交易所有本策略對應方向持倉，本地也有持倉（完全信任本地記錄） ───
    if (myDirectionPos && localState.totalSize > 0) {
      console.log(`[Reconcile] 策略 ${strategyId} 信任本地記錄 (size=${localState.totalSize}, layer=${localState.currentLayer}, isLong=${localState.isLong})，不修正`);
      return { matched: true, corrections, localState };
    }
    
    // ─── 情境 2b：交易所有持倉（但不是本策略方向），本地也有持倉 → 本策略已被平倉 ───
    if (pos && !myDirectionPos && localState.totalSize > 0) {
      // 已在情境 1.5 處理，此處不應到達，但作為安全網
      corrections.push(`帳戶有持倉但非本策略方向，重置本地狀態`);
      const reset = createInitialStrategyState();
      reset.isCooldown = localState.isCooldown;
      reset.cooldownUntil = localState.cooldownUntil;
      await saveStrategyState(strategyId, reset);
      return { matched: false, corrections, localState: reset };
    }

    // ─── 情境 3：交易所有持倉，但本地無持倉（totalSize=0, currentLayer=0） ───
    if (pos && localState.totalSize <= 0 && localState.currentLayer === 0) {
      // 不自動恢復！只記錄日誌。
      // 這可能是其他策略的持倉，或者是手動在交易所開的倉。
      // 自動恢復會導致多策略互相干擾（之前的 bug 根因）。
      console.log(`[Reconcile][TrustLocal] 策略 ${strategyId} 交易所有持倉 ${pos.size} (${pos.side}) 但本地無記錄，不自動恢復（可能屬於其他策略或手動開倉）`);
      return { matched: true, corrections, localState };
    }

    // ─── 情境 4：本地 currentLayer=0 但 totalSize > 0（狀態不一致） ───
    if (localState.currentLayer === 0 && localState.totalSize > 0) {
      corrections.push(
        `本地有持倉數量 ${localState.totalSize} 但 currentLayer=0，修正為 1`,
      );
      const fixed: StrategyState = {
        ...localState,
        currentLayer: 1,
      };
      await saveStrategyState(strategyId, fixed);
      return { matched: false, corrections, localState: fixed };
    }

    // ─── 其他情況：一致，無需修正 ───
    console.log(`[Reconcile] 策略 ${strategyId} 對賬一致，無需修正`);
    return { matched: true, corrections, localState };
  } catch (e: unknown) {
    corrections.push(`對賬失敗：${e instanceof Error ? e.message : String(e)}`);
    return { matched: false, corrections, localState };
  }
}
