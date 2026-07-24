/**
 * 參數驗證與聯動（Pasted_content_22.txt BE-1，用戶提供代碼原樣整合）
 *
 * 職責：
 * 1. 驗證階梯式馬丁層數範圍是否重疊 / 是否連續（有間隙拋錯）
 * 2. 自動計算 Max_Layers（= 最後一層的 end 值）；用戶手動值不一致時以分層為準
 * 3. 決定使用固定乘數（fixed）還是階梯式乘數（layered），回傳 effectiveMultiplier 函數
 *
 * 與 martingaleEngine.ts 的分工：
 * - parameterValidator：入口驗證層（拋錯 / 聯動計算），供 router 與引擎啟動時調用
 * - martingaleEngine.getLayerMultiplier / calculateLayerLot：運行時逐層計算（帶安全 fallback）
 */

import { parseMartinLayers, type MartinLayerRule } from "./martingaleEngine";

export interface MartinLayer {
  start: number;
  end: number;
  multiplier: number;
}

export interface MartinProcessResult {
  maxLayers: number;
  /** 回傳指定層數的有效乘數 */
  effectiveMultiplier: (layer: number) => number;
  usedMode: "fixed" | "layered";
  /** 排序後的分層規則（layered 模式時有值） */
  sortedLayers: MartinLayerRule[] | null;
}

/**
 * BE-1：驗證階梯式馬丁參數（用戶提供代碼，原樣整合）
 * 1. 檢查層數範圍是否重疊
 * 2. 檢查 Max_Layers 是否與最後一層匹配
 * 3. 決定使用固定乘數還是階梯式乘數
 */
export function validateAndProcessMartinConfig(config: {
  Max_Layers?: unknown;
  Martin_Multiplier?: unknown;
  Martin_Layers?: unknown;
}): MartinProcessResult {
  const maxLayersInput = Number(config.Max_Layers);
  const martinMultiplier = Number(config.Martin_Multiplier);
  const martinLayers = parseMartinLayersStrict(config.Martin_Layers);

  // 情況 1：無階梯式分層 → 使用固定乘數
  if (!martinLayers || martinLayers.length === 0) {
    return {
      maxLayers: Number.isFinite(maxLayersInput) && maxLayersInput > 0 ? maxLayersInput : 5,
      effectiveMultiplier: () =>
        Number.isFinite(martinMultiplier) && martinMultiplier > 0 ? martinMultiplier : 1.5,
      usedMode: "fixed",
      sortedLayers: null,
    };
  }

  // 情況 2：有階梯式分層 → 驗證並使用階梯式乘數
  // 2.1 檢查層數範圍是否重疊 / 是否連續
  const sortedLayers = [...martinLayers].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedLayers.length; i++) {
    const prev = sortedLayers[i - 1];
    const curr = sortedLayers[i];
    if (curr.start <= prev.end) {
      throw new Error(
        `階梯式馬丁層數範圍重疊：第 ${prev.start}-${prev.end} 層 與 第 ${curr.start}-${curr.end} 層重疊，請修正。`,
      );
    }
    if (curr.start > prev.end + 1) {
      throw new Error(
        `階梯式馬丁層數範圍不連續：第 ${prev.end} 層 到 第 ${curr.start} 層之間有間隙，請補齊。`,
      );
    }
  }

  // 2.2 計算最大層數（最後一層的 end 值）
  const calculatedMaxLayers = sortedLayers[sortedLayers.length - 1].end;

  // 2.3 若用戶手動設置了 Max_Layers，驗證是否一致（不一致時以分層計算值為準）
  if (Number.isFinite(maxLayersInput) && maxLayersInput > 0 && maxLayersInput !== calculatedMaxLayers) {
    console.warn(
      `[parameterValidator] Max_Layers (${maxLayersInput}) 與階梯式分層最後一層 (${calculatedMaxLayers}) 不一致，將使用階梯式分層的 ${calculatedMaxLayers}`,
    );
  }

  return {
    maxLayers: calculatedMaxLayers,
    effectiveMultiplier: (layer: number) => {
      for (const rule of sortedLayers) {
        if (layer >= rule.start && layer <= rule.end) {
          return rule.multiplier;
        }
      }
      // 若超出定義範圍，使用最後一層的乘數
      return sortedLayers[sortedLayers.length - 1].multiplier;
    },
    usedMode: "layered",
    sortedLayers,
  };
}

/**
 * 嚴格解析 Martin_Layers：
 * - 空值 / 空陣列 → null（回退 fixed 模式）
 * - 格式非法（非陣列、欄位缺失、start > end、multiplier <= 0）→ 拋錯（入口防線）
 * 與 parseMartinLayers（寬鬆版，非法回 null）不同，此處用於入口驗證需明確報錯。
 */
export function parseMartinLayersStrict(raw: unknown): MartinLayerRule[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let arr: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "[]") return null;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new Error("階梯式馬丁分層格式錯誤：無法解析 JSON。");
    }
  }
  if (!Array.isArray(arr)) {
    throw new Error("階梯式馬丁分層格式錯誤：必須為陣列。");
  }
  if (arr.length === 0) return null;

  const rules: MartinLayerRule[] = [];
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const start = Number(o?.start);
    const end = Number(o?.end);
    const multiplier = Number(o?.multiplier);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(multiplier)) {
      throw new Error("階梯式馬丁分層格式錯誤：start / end / multiplier 必須為數值。");
    }
    if (start < 1) throw new Error(`階梯式馬丁分層錯誤：起始層必須 >= 1（收到 ${start}）。`);
    if (start > end) throw new Error(`階梯式馬丁分層錯誤：起始層 ${start} 不可大於結束層 ${end}。`);
    if (multiplier <= 0) throw new Error(`階梯式馬丁分層錯誤：乘數必須 > 0（收到 ${multiplier}）。`);
    const rule: MartinLayerRule = { start, end, multiplier };
    // 保留每層專屬間距（stepPct）
    const stepPctVal = Number(o?.stepPct);
    if (Number.isFinite(stepPctVal) && stepPctVal > 0) {
      rule.stepPct = stepPctVal;
    }
    rules.push(rule);
  }
  return rules;
}

/**
 * 在策略引擎中使用（用戶提供代碼，原樣整合）：
 * 驗證 + 輸出模式與各層乘數日誌，回傳處理結果供引擎接線
 */
export function getMartinConfig(config: {
  Max_Layers?: unknown;
  Martin_Multiplier?: unknown;
  Martin_Layers?: unknown;
}): MartinProcessResult {
  const result = validateAndProcessMartinConfig(config);

  console.log(`[parameterValidator] 馬丁模式: ${result.usedMode === "layered" ? "階梯式分層" : "固定乘數"}`);
  console.log(`[parameterValidator] 最大層數: ${result.maxLayers}`);

  if (result.usedMode === "layered") {
    for (let i = 1; i <= result.maxLayers; i++) {
      console.log(`  第 ${i} 層乘數: ${result.effectiveMultiplier(i)}`);
    }
  }

  return result;
}

/** 供前端/引擎共用的最大層數計算（UI-1 後端對應：空分層回退預設 5） */
export function calculateMaxLayersFromConfig(config: {
  Max_Layers?: unknown;
  Martin_Layers?: unknown;
}): number {
  let rawLayers: any = config.Martin_Layers;
  if (typeof rawLayers === "string") {
    try {
      rawLayers = JSON.parse(rawLayers);
    } catch (e) {
      console.warn("[parameterValidator] Failed to parse Martin_Layers string:", e);
      rawLayers = [];
    }
  }
  const layers = parseMartinLayers(rawLayers || []);
  if (layers && layers.length > 0) {
    const sorted = [...layers].sort((a, b) => a.start - b.start);
    return sorted[sorted.length - 1].end;
  }
  const n = Number(config.Max_Layers);
  return Number.isFinite(n) && n > 0 ? n : 5;
}
