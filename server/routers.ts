import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import * as db from "./db";
import { createAdapter } from "./exchanges/factory";
import { decrypt, encrypt, generateWebhookSecret, maskKey } from "./lib/crypto";
import {
  compileAndLoadStrategy,
  initStrategyStudio,
  getStrategy,
  isBuiltInKey,
  listRegisteredStrategies,
  unregisterStrategy,
} from "./services/strategyStudio";
import { exchangeRouter } from "./routers/exchange.router";
import { backtestRouter } from "./routers/backtest.router";
import { autoTradeRouter } from "./routers/autoTrade.router";
import { rainbowTrendLadderAiRouter } from "./routers/rainbowTrendLadderAi.router";
import { tradeJournalRouter } from "./routers/tradeJournal.router";
import { registryManager } from "./services/registryManager";
import { telegramNotifier } from "./services/telegramNotifier";
import { pickStrategyConfigState } from "./services/strategySnapshotConfig";
import { summarizeStrategyPerformance } from "./services/performanceSummary";
import {
  assertValidV25Config,
  deriveV25MaxMartinLayer,
  V25_STRATEGY_KEY,
} from "../shared/strategies/kama3kBreakoutV25";
import {
  assertValidRainbow20415Config,
  deriveRainbow20415FinalEnabledLayer,
  getRainbow20415RangeForLayer,
  RAINBOW_20415_STRATEGY_KEY,
} from "../shared/strategies/rainbow20415";
import {
  assertValidRainbowTrendLadderConfig,
  RAINBOW_TREND_LADDER_STRATEGY_KEY,
} from "../shared/strategies/rainbowTrendLadder";
import {
  deploymentPositionColumns,
  finalizeDeploymentPosition,
  resolveDeploymentPosition,
} from "./services/deploymentPosition";
import { getAccountPositionSnapshot } from "./services/strategyPositionSnapshot";
import { recordExistingTradeExecution } from "./services/tradeExecutionLedger";
import { evaluateMartingaleStrategyInstance } from "./services/martingaleCapability";
import { getMartingaleLayerSnapshotsForUser } from "./services/martingaleLayerSnapshot";
import {
  normalizeV40EntryGateConfig,
  V40_STRATEGY_KEY,
} from "./strategies/v35/entryGate";
import {
  V41_CONFIG_SCHEMA,
  V41_STRATEGY_KEY,
} from "../shared/strategies/kama3kMartinV41";
import {
  assertV41ConfigIsolation,
  attachV41StrategyConfig,
  deriveV41StrategyColumns,
  resolveV41ConfigForStrategy,
} from "./services/v41StrategyConfig";

/* ==================== API 金鑰路由 ==================== */

/** 任務 1.5：取得伺服器公網 IP（快取 10 分鐘，避免重複外部請求） */
let cachedServerIps: { ips: Set<string>; fetchedAt: number } | null = null;

async function getAllServerIPs(): Promise<string[]> {
  if (cachedServerIps && Date.now() - cachedServerIps.fetchedAt < 10 * 60 * 1000) {
    return Array.from(cachedServerIps.ips).sort();
  }
  const ips = new Set<string>();
  const sources = ["https://api.ipify.org?format=json", "https://ifconfig.me/all.json"];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of sources) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const data: any = await res.json();
        const ip = data.ip || data.ip_addr;
        if (ip) ips.add(ip);
      } catch {}
    }
    if (ips.size > 0) break;
  }
  cachedServerIps = { ips, fetchedAt: Date.now() };
  return Array.from(ips).sort();
}

async function getServerPublicIP(): Promise<string> {
  const ips = await getAllServerIPs();
  return ips.length > 0 ? ips[0] : "無法取得";
}

/** TradingView Webhook 發送伺服器 IP 列表（官方公布，供用戶參考） */
const TRADINGVIEW_WEBHOOK_IPS = [
  "52.89.214.238",
  "34.212.75.30",
  "54.218.53.128",
  "52.32.178.7",
];

const apiKeysRouter = router({
  /** 任務 1.5：回傳伺服器公網 IP，供用戶加入交易所白名單；並附 TradingView Webhook IP 列表 */
  getServerIP: protectedProcedure.query(async () => {
    const ips = await getAllServerIPs();
    const ip = ips.length > 0 ? ips[0] : "無法取得";
    return {
      ip,
      allIps: ips,
      tradingViewIPs: TRADINGVIEW_WEBHOOK_IPS,
      message: `請將伺服器 IP (${ips.join(", ") || ip}) 加入交易所 API 白名單；若您的防火牆需限制 Webhook 來源，請允許 TradingView IP：${TRADINGVIEW_WEBHOOK_IPS.join(", ")}。`,
    };
  }),

  /** 任務 1.4：儲存前以原始憑證測試連線（不寫入資料庫）
   * 注意：使用 publicProcedure 因為此時用戶還未保存金鑰，不需要認證 */
  testCredentials: publicProcedure
    .input(
      z.object({
        exchange: z.enum(["bybit", "okx"]),
        apiKey: z.string().min(1),
        apiSecret: z.string().min(1),
        passphrase: z.string().optional(),
        isTestnet: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      // 任務 1.3：全域 try-catch，任何錯誤（含逾時）都回傳明確訊息讓前端停止 Loading
      try {
        if (input.exchange === "okx" && !input.passphrase) {
          return { success: false, message: "OKX 需要提供 Passphrase" };
        }
        const serverIp = await getServerPublicIP();
        const adapter = createAdapter({
          exchange: input.exchange,
          apiKeyEncrypted: encrypt(input.apiKey),
          apiSecretEncrypted: encrypt(input.apiSecret),
          passphraseEncrypted: input.passphrase ? encrypt(input.passphrase) : null,
          isTestnet: input.isTestnet,
        } as any);
        return await adapter.testConnection(serverIp);
      } catch (e: any) {
        // 淨化錯誤訊息：移除換行、特殊字符，確保回傳有效的 JSON
        let errorMsg = (e?.message || "未知錯誤").toString().replace(/[\n\r]/g, " ").slice(0, 500);
        // 如果是 IP 白名單錯誤，附加伺服器 IP 供用戶參考
        if (errorMsg.includes("10010") || errorMsg.includes("Unmatched IP") || errorMsg.includes("IP")) {
          const serverIp = await getServerPublicIP();
          errorMsg += ` [伺服器 IP: ${serverIp}]`;
        }
        return { success: false, message: `測試失敗：${errorMsg}` };
      }
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const keys = await db.listApiKeys(ctx.user.id);
    // 僅回傳遮蔽後的金鑰，絕不回傳明文或密文
    return keys.map((k) => ({
      id: k.id,
      label: k.label,
      exchange: k.exchange,
      apiKeyMasked: maskKey(safeDecrypt(k.apiKeyEncrypted)),
      hasPassphrase: !!k.passphraseEncrypted,
      isTestnet: k.isTestnet,
      lastTestStatus: k.lastTestStatus,
      lastTestAt: k.lastTestAt,
      lastTestMessage: k.lastTestMessage,
      createdAt: k.createdAt,
    }));
  }),

  create: protectedProcedure
    .input(
      z.object({
        label: z.string().min(1).max(100),
        exchange: z.enum(["bybit", "okx"]),
        apiKey: z.string().min(1),
        apiSecret: z.string().min(1),
        passphrase: z.string().optional(),
        isTestnet: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.exchange === "okx" && !input.passphrase) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "OKX 需要提供 Passphrase",
        });
      }
      await db.createApiKey({
        userId: ctx.user.id,
        label: input.label,
        exchange: input.exchange,
        apiKeyEncrypted: encrypt(input.apiKey),
        apiSecretEncrypted: encrypt(input.apiSecret),
        passphraseEncrypted: input.passphrase ? encrypt(input.passphrase) : null,
        isTestnet: input.isTestnet,
      });
      return { success: true };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        label: z.string().min(1).max(100).optional(),
        apiKey: z.string().optional(),
        apiSecret: z.string().optional(),
        passphrase: z.string().optional(),
        isTestnet: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.getApiKeyById(input.id, ctx.user.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "金鑰不存在" });
      }
      const data: Record<string, unknown> = {};
      if (input.label !== undefined) data.label = input.label;
      if (input.apiKey) data.apiKeyEncrypted = encrypt(input.apiKey);
      if (input.apiSecret) data.apiSecretEncrypted = encrypt(input.apiSecret);
      if (input.passphrase) data.passphraseEncrypted = encrypt(input.passphrase);
      if (input.isTestnet !== undefined) data.isTestnet = input.isTestnet;
      data.lastTestStatus = "untested";
      await db.updateApiKey(input.id, ctx.user.id, data);
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // 檢查是否有策略仍在使用此金鑰
      const userStrategies = await db.listStrategies(ctx.user.id);
      const inUse = userStrategies.some((s) => s.apiKeyId === input.id);
      if (inUse) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "仍有策略綁定此金鑰，請先刪除或改綁相關策略",
        });
      }
      await db.deleteApiKey(input.id, ctx.user.id);
      return { success: true };
    }),

  testConnection: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const keyRecord = await db.getApiKeyById(input.id, ctx.user.id);
      if (!keyRecord) {
        throw new TRPCError({ code: "NOT_FOUND", message: "金鑰不存在" });
      }
      let result: { success: boolean; message: string; balance?: number };
      try {
        const serverIp = await getServerPublicIP();
        const adapter = createAdapter(keyRecord);
        result = await adapter.testConnection(serverIp);
      } catch (e: any) {
        // 淨化錯誤訊息：移除換行、特殊字符，確保回傳有效的 JSON
        const errorMsg = (e?.message || "未知錯誤").toString().replace(/[\n\r]/g, " ").slice(0, 500);
        result = { success: false, message: `建立連線失敗：${errorMsg}` };
      }
      await db.updateApiKey(input.id, ctx.user.id, {
        lastTestStatus: result.success ? "success" : "failed",
        lastTestAt: new Date(),
        lastTestMessage: result.message,
      });
      return result;
    }),
});

function safeDecrypt(ciphertext: string): string {
  try {
    return decrypt(ciphertext);
  } catch {
    return "********";
  }
}

/* ==================== 策略路由 ==================== */

const strategyInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  apiKeyId: z.number(),
  symbol: z.string().min(1).max(32),
  positionSize: z.number().positive(),
  // 新增：倉位模式（'quantity' = BTC 數量，'usdt' = USDT 金額）
  positionMode: z.enum(['quantity', 'usdt']).default('quantity'),
  leverage: z.number().int().min(1).max(125).default(1),
  direction: z.enum(["long", "short", "both"]).default("both"),
  orderType: z.enum(["market", "limit"]).default("market"),
  maxPositionPct: z.number().min(0).max(100).default(0),
  stopLossPct: z.number().min(0).max(100).default(0),
  takeProfitPct: z.number().min(0).max(1000).default(0),
  maxDailyLoss: z.number().min(0).default(0),
  // 任務 3.3：馬丁參數
  martinMultiplier: z.number().min(1).max(10).default(1),
  maxMartinLevel: z.number().int().min(1).default(1),
  martinSpacingPct: z.number().min(0).default(0),
  strategyKey: z.string().max(100).optional().nullable(),
  // V2.5：KAMA 三K突破｜階梯式馬丁（無固定層數上限）
  v25Config: z
    .object({
      KAMA_Fast_Length: z.number().int().min(5).max(200),
      p2_fastest: z.number().int().min(2).max(20),
      p3_slowest: z.number().int().min(1).max(10),
      KAMA_Slow_Length: z.number().int().min(5).max(200),
      q2_fastest: z.number().int().min(2).max(20),
      q3_slowest: z.number().int().min(1).max(10),
      Base_Lot_Size: z.number().min(1),
      Hard_Stop_Loss_Pct: z.number().min(0).max(10),
      Take_Profit_Pct: z.number().min(0).max(10),
      Trailing_TP_Enabled: z.boolean(),
      Trailing_Activation_Pct: z.number().min(0.1).max(5),
      Trailing_Callback_Pct: z.number().min(0.05).max(3),
      Martin_Enabled: z.boolean(),
      Martin_Ranges: z.array(z.object({
        start: z.number().int().min(1),
        end: z.number().int().min(1),
        multiplier: z.number().min(0.1).max(5),
        gap: z.number().min(0.1).max(20),
      })).min(1),
      Reentry_On_Trend: z.boolean(),
      K_Line_Period: z.number().int().min(1).max(1440),
    })
    .partial()
    .optional(),
  // Pasted_content_21 核心優化 + V3.7 硬止損（Pasted_content_23），存入 martinState.__v35Config
  // V3.7：❌ Kama_Reversal_Min_Layer 已移除，改用 Max_Loss_Pct 純硬止損
  v35Config: z
    .object({
      Martin_Layers: z.string().max(2000).default(""),
      Reentry_On_Trend: z.boolean().default(true),
      Max_Loss_USDT: z.number().min(0).default(100),
      /** 🆕 V3.7：硬止損觸發閾值（總浮虧 %，0 = 不啟用，建議 6） */
      Max_Loss_Pct: z.number().min(0).max(50).default(6),
      /** V3.7：移動止盈回撤（%，預設 0.1） */
      Callback_Pct: z.number().min(0.01).max(10).default(0.1),
      /** V3.7：K 線週期（分鐘，預設 15） */
      K_Line_Period: z.number().min(1).max(1440).default(15),
      /** V4.0：初始本金 (USDT) */
      Initial_Capital: z.number().min(10).default(10000).optional(),
      /** V4.0：首單佔本金百分比 */
      First_Order_Pct: z.number().min(0.01).max(10).default(0.3).optional(),
      /** V4.0：slow KAMA 方向鎖計算參數 */
      KAMA_Slow_Length: z.number().int().min(5).max(200).default(50).optional(),
      q2_fastest: z.number().min(1).max(50).default(10).optional(),
      q3_slowest: z.number().min(1).max(50).default(6).optional(),
      /** V4.0：三 K 總開關與互斥模式 */
      enableThreeKFilter: z.boolean().default(true).optional(),
      threeKPatternMode: z.enum(["breakout", "three_body_same_direction"]).default("breakout").optional(),
      /** V4.0：price／slow KAMA 方向鎖 */
      enableKamaDirectionLock: z.boolean().default(true).optional(),
      /** V4.0：第 0 層順勢平倉後原地重入 */
      enableSameDirectionReentry: z.boolean().default(true).optional(),
    })
    .optional(),
  // V5.0：KAMA 3K 極致優化馬丁策略參數
  v50Config: z
    .object({
      Initial_Capital: z.number().min(10).default(10000).optional(),
      Base_Lot_Size: z.number().min(1).default(30).optional(),
      First_Order_Pct: z.number().min(0.01).max(10).default(0.3).optional(),
      KAMA_Fast_Length: z.number().min(5).max(200).default(30).optional(),
      p2_fastest: z.number().min(2).max(50).default(8).optional(),
      p3_slowest: z.number().min(2).max(50).default(2).optional(),
      KAMA_Slow_Length: z.number().min(5).max(200).default(55).optional(),
      q2_fastest: z.number().min(2).max(50).default(10).optional(),
      q3_slowest: z.number().min(2).max(50).default(8).optional(),
      Martin_Multiplier: z.number().min(1).max(5).default(1.5).optional(),
      Max_Layers: z.number().int().min(1).default(13).optional(),
      Martin_Step_Pct: z.number().min(0.01).default(2.0).optional(),
      Martin_Layers: z.string().max(2000).default("").optional(),
      Target_TP_Pct: z.number().min(0.1).max(50).default(1.0).optional(),
      Callback_Pct: z.number().min(0.01).max(5).default(0.1).optional(),
      Max_Loss_Pct: z.number().min(0).max(50).default(6).optional(),
      Max_Drawdown_Pct: z.number().min(0).max(50).default(10).optional(),
      Max_Loss_USDT: z.number().min(0).default(0).optional(),
      K_Line_Period: z.number().min(1).max(1440).default(15).optional(),
      Reentry_On_Trend: z.boolean().default(true).optional(),
      // F1
      enable_regime_switch: z.boolean().default(true).optional(),
      adx_period: z.number().min(5).max(50).default(14).optional(),
      atr_period: z.number().min(5).max(50).default(14).optional(),
      adx_strong_threshold: z.number().min(15).max(50).default(30).optional(),
      adx_weak_threshold: z.number().min(10).max(40).default(20).optional(),
      // F2
      enable_partial_tp: z.boolean().default(true).optional(),
      partial_tp_layer_4: z.number().min(0.05).max(0.8).default(0.3).optional(),
      partial_tp_layer_6: z.number().min(0.05).max(0.8).default(0.3).optional(),
      partial_tp_layer_8: z.number().min(0.05).max(0.8).default(0.2).optional(),
      partial_tp_trigger_pct: z.number().min(0.1).max(5).default(0.5).optional(),
      // F3
      enable_dynamic_tp: z.boolean().default(true).optional(),
      tp_min_pct: z.number().min(0.1).max(10).default(0.8).optional(),
      tp_atr_multiplier: z.number().min(0.5).max(10).default(2.5).optional(),
      // F4
      enable_time_filter: z.boolean().default(true).optional(),
      allowed_start_hour: z.number().min(0).max(23).default(12).optional(),
      allowed_end_hour: z.number().min(0).max(23).default(22).optional(),
      // F5
      enable_vol_position: z.boolean().default(true).optional(),
      target_vol_pct: z.number().min(0.5).max(5).default(1.5).optional(),
      vol_min_scale: z.number().min(0.1).max(1).default(0.5).optional(),
      vol_max_scale: z.number().min(1).max(5).default(2.0).optional(),
      // F6
      enable_ai_filter: z.boolean().default(true).optional(),
      kama_slope_lookback: z.number().min(2).max(20).default(5).optional(),
      kama_slope_min: z.number().min(0.01).max(1).default(0.05).optional(),
      volume_ma_period: z.number().min(5).max(50).default(20).optional(),
      volume_expansion_threshold: z.number().min(1.0).max(5.0).default(1.5).optional(),
    })
    .optional(),
  // 20415 七彩虹：結構由 shared/strategies/rainbow20415.ts 單一契約正規化與嚴格校驗。
  v2_0Config: z.record(z.string(), z.unknown()).optional(),
  // 全新七彩虹線趨勢跟蹤階梯馬丁：獨立契約，不共用 20415 設定鍵。
  rainbowTrendLadderConfig: z.record(z.string(), z.unknown()).optional(),
  // V6.1：KAMA 3K 高頻掃射極致版參數
  v61Config: z
    .object({
      kama_fast_length: z.number().min(10).max(100).default(30).optional(),
      kama_fast_fastest: z.number().min(2).max(20).default(8).optional(),
      kama_fast_slowest: z.number().min(1).max(50).default(2).optional(),
      kama_slow_length: z.number().min(10).max(100).default(55).optional(),
      kama_slow_fastest: z.number().min(2).max(20).default(10).optional(),
      kama_slow_slowest: z.number().min(1).max(50).default(8).optional(),
      buffer_atr_multiplier_trend: z.number().min(0.1).max(0.8).default(0.25).optional(),
      buffer_atr_multiplier_weak: z.number().min(0.1).max(0.8).default(0.30).optional(),
      buffer_atr_multiplier_ranging: z.number().min(0.1).max(0.8).default(0.50).optional(),
      entry_zone_mode: z.enum(["inside", "breakout"]).default("breakout").optional(),
      direction_mode: z.enum(["trend", "hybrid", "both"]).default("hybrid").optional(),
      min_atr_ratio: z.number().min(0.4).max(1.0).default(0.7).optional(),
      enable_continuous_entry: z.union([z.boolean(), z.string(), z.number()]).default("1").optional(),
      cooldown_minutes: z.number().min(0).max(60).default(0).optional(),
      enable_bar_lock: z.boolean().default(false).optional(),
      adx_period: z.number().min(7).max(30).default(14).optional(),
      adx_trend_threshold: z.number().min(10).max(50).default(25).optional(),
      adx_strong_threshold: z.number().min(20).max(50).default(30).optional(),
      atr_ratio_threshold: z.number().min(1.0).max(2.0).default(1.2).optional(),
      tp_atr_multiplier: z.number().min(0.5).max(3.0).default(1.5).optional(),
      callback_atr_multiplier: z.number().min(0.1).max(0.8).default(0.3).optional(),
      tp_min_pct: z.number().min(0.2).max(2.0).default(0.5).optional(),
      callback_min_pct: z.number().min(0.05).max(0.5).default(0.15).optional(),
      target_volatility: z.number().min(2.0).max(8.0).default(4.0).optional(),
      base_lot_size: z.number().min(5).max(100).default(15).optional(),
      lot_min_multiplier: z.number().min(0.3).max(0.8).default(0.5).optional(),
      lot_max_multiplier: z.number().min(1.2).max(3.0).default(2.0).optional(),
      enable_loss_shrink: z.union([z.boolean(), z.string(), z.number()]).default("1").optional(),
      loss_shrink_level1: z.number().min(1).max(10).default(3).optional(),
      loss_shrink_level1_pct: z.number().min(50).max(90).default(70).optional(),
      loss_shrink_level2: z.number().min(3).max(15).default(5).optional(),
      loss_shrink_level2_pct: z.number().min(30).max(70).default(50).optional(),
      max_daily_trades: z.number().min(5).max(50).default(20).optional(),
      max_daily_loss: z.number().min(1.0).max(5.0).default(3.0).optional(),
    })
    .optional(),
  // V7.0 龍捲風雙渦輪配置
  v70Config: z
    .object({
      base_lot_size_usdt: z.number().min(10).max(10000).default(150).optional(),
      leverage: z.number().min(1).max(125).default(5).optional(),
      timeframe: z.string().default('5m').optional(),
      ma200_enabled: z.boolean().default(true).optional(),
      ma200_period: z.number().min(50).max(500).default(200).optional(),
      ma200_type: z.enum(['SMA', 'EMA']).default('SMA').optional(),
      ma200_oscillation_filter_pct: z.number().min(0).max(1).default(0.015).optional(),
      kama_fast_er_period: z.number().min(10).max(200).default(50).optional(),
      kama_fast_fast_const: z.number().min(2).max(50).default(10).optional(),
      kama_fast_slow_const: z.number().min(1).max(20).default(2).optional(),
      kama_slow_er_period: z.number().min(10).max(200).default(50).optional(),
      kama_slow_fast_const: z.number().min(2).max(50).default(10).optional(),
      kama_slow_slow_const: z.number().min(1).max(20).default(6).optional(),
      cross_mode: z.enum(['both', 'long_only', 'short_only']).default('both').optional(),
      risk_hard_stop_pct: z.number().min(0).max(20).default(4.5).optional(),
      risk_ma_force_liq: z.boolean().default(true).optional(),
      risk_reverse_cross_close: z.boolean().default(true).optional(),
      risk_reverse_cross_profit_limit: z.number().min(0).max(10).default(1.5).optional(),
      trailing_enabled: z.boolean().default(true).optional(),
      trailing_activation_pct: z.number().min(0.5).max(20).default(3.0).optional(),
      trailing_retracement_pct: z.number().min(0.1).max(10).default(1.5).optional(),
      martin_enabled: z.boolean().default(true).optional(),
      martin_max_layers: z.number().min(1).max(30).default(11).optional(),
      martin_layer_tp_long: z.number().min(0.05).max(5).default(0.30).optional(),
      martin_layer_tp_short: z.number().min(0.05).max(5).default(0.20).optional(),
      martin_layers: z.string().max(3000).default('').optional(),
    })
    .optional(),
  // V4.1：完整 canonical 配置；API 寫入仍會再執行同 key 與 0/3 fail-closed 驗證。
  v41Config: V41_CONFIG_SCHEMA.optional(),
});

/** O1：伺服器端驗證 Martin_Layers JSON（重疊/非法値），回傳錯誤訊息或 null */
function validateMartinLayersJson(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return "Martin_Layers 不是合法的 JSON";
  }
  if (!Array.isArray(arr)) return "Martin_Layers 必須是陣列";
  const rules = arr.map((r: any) => ({
    start: Number(r?.start),
    end: Number(r?.end),
    multiplier: Number(r?.multiplier),
  }));
  for (const r of rules) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || !Number.isFinite(r.multiplier))
      return "分層規則含非法數值";
    if (r.start < 1) return `起始層必須 ≥ 1（收到 ${r.start}）`;
    if (r.start > r.end) return `起始層 ${r.start} 不可大於結束層 ${r.end}`;
    if (r.multiplier <= 0) return `乘數必須 > 0（收到 ${r.multiplier}）`;
  }
  const sorted = [...rules].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end)
      return `層數範圍重疊：${sorted[i - 1].start}-${sorted[i - 1].end} 與 ${sorted[i].start}-${sorted[i].end} 衝突`;
    // BE-1（Pasted_content_22）：間隙檢查，與 parameterValidator 一致
    if (sorted[i].start > sorted[i - 1].end + 1)
      return `層數範圍不連續：第 ${sorted[i - 1].end} 層到第 ${sorted[i].start} 層之間有間隙，請補齊`;
  }
  return null;
}

/** 組出完整的 webhook URL（依當前請求的 host） */
function buildWebhookUrl(req: any, strategyId: number, secret: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  return `${proto.split(",")[0]}://${host}/api/webhook/${strategyId}?secret=${secret}`;
}

const strategiesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const items = await db.listStrategies(ctx.user.id);
    return items.map((s) => {
      const capability = evaluateMartingaleStrategyInstance(s);
      return {
        ...s,
        webhookUrl: buildWebhookUrl(ctx.req, s.id, s.webhookSecret),
        martingaleLayerCapability: {
          isMartingale: capability.isMartingale,
          maxLayers: capability.maxLayers,
          reason: capability.reason,
        },
      };
    });
  }),

  /**
   * 只為已展開的馬丁卡片批次取得逐層詳情。
   * requested IDs 會在 service 內重新套用 user owner + fail-closed capability 雙重過濾。
   */
  martingaleLayerSnapshots: protectedProcedure
    .input(z.object({
      strategyIds: z.array(z.number().int().positive()).min(1).max(100)
        .transform(ids => Array.from(new Set(ids))),
      forceRefresh: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => getMartingaleLayerSnapshotsForUser(
      ctx.user.id,
      input.strategyIds,
      { forceRefresh: input.forceRefresh, includeMarketData: true },
    )),

  /** 卡片級輕量摘要：只計算 ledger 的活躍循環／未平層數，不觸發交易所查詢。 */
  martingaleLayerSummaries: protectedProcedure
    .input(z.object({
      strategyIds: z.array(z.number().int().positive()).min(1).max(100)
        .transform(ids => Array.from(new Set(ids))),
    }))
    .query(async ({ ctx, input }) => {
      const snapshots = await getMartingaleLayerSnapshotsForUser(
        ctx.user.id,
        input.strategyIds,
        { forceRefresh: false, includeMarketData: false },
      );
      return snapshots.map(snapshot => ({
        strategyId: snapshot.strategyId,
        activeCycleCount: snapshot.activeCycleCount,
        openLayerCount: snapshot.openLayerCount,
        availability: snapshot.availability,
        availabilityReason: snapshot.availabilityReason,
      }));
    }),

  create: protectedProcedure
    .input(strategyInputSchema)
    .mutation(async ({ ctx, input }) => {
      const keyRecord = await db.getApiKeyById(input.apiKeyId, ctx.user.id);
      if (!keyRecord) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "選擇的 API 金鑰不存在",
        });
      }
      const v40Config = input.strategyKey === V40_STRATEGY_KEY
        ? {
            ...(input.v35Config ?? {}),
            ...normalizeV40EntryGateConfig(input.v35Config as Record<string, unknown> | undefined),
          }
        : input.v35Config;
      let v41Config: ReturnType<typeof resolveV41ConfigForStrategy>;
      try {
        assertV41ConfigIsolation(input.strategyKey ?? "", {
          v25Config: input.v25Config,
          v35Config: input.v35Config,
          v50Config: input.v50Config,
          v61Config: input.v61Config,
          v70Config: input.v70Config,
          v2_0Config: input.v2_0Config,
          rainbowTrendLadderConfig: input.rainbowTrendLadderConfig,
        });
        v41Config = resolveV41ConfigForStrategy(input.strategyKey ?? "", input.v41Config, {
          required: input.strategyKey === V41_STRATEGY_KEY,
        });
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `V4.1 參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      // O1：伺服器端驗證階梯式分層
      if (v40Config?.Martin_Layers) {
        const layersErr = validateMartinLayersJson(v40Config.Martin_Layers);
        if (layersErr) throw new TRPCError({ code: "BAD_REQUEST", message: `階梯式馬丁分層設定錯誤：${layersErr}` });
      }
      let v25Config: ReturnType<typeof assertValidV25Config> | undefined;
      if (input.strategyKey === V25_STRATEGY_KEY) {
        try {
          v25Config = assertValidV25Config(input.v25Config);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `V2.5 參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      let rainbow20415Config: ReturnType<typeof assertValidRainbow20415Config> | undefined;
      if (input.strategyKey === RAINBOW_20415_STRATEGY_KEY) {
        try {
          rainbow20415Config = assertValidRainbow20415Config(input.v2_0Config);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `20415 七彩虹參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      let rainbowTrendLadderConfig: ReturnType<typeof assertValidRainbowTrendLadderConfig> | undefined;
      if (input.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY) {
        try {
          rainbowTrendLadderConfig = assertValidRainbowTrendLadderConfig(input.rainbowTrendLadderConfig);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `七彩虹線階梯策略參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const firstV25Range = v25Config?.Martin_Ranges[0];
      const firstRainbowRange = rainbow20415Config
        ? getRainbow20415RangeForLayer(rainbow20415Config.Martin_Ranges, 1)
        : undefined;
      const firstRainbowTrendAddLayer = rainbowTrendLadderConfig?.Martin_Layers.find(
        (layer) => layer.enabled && layer.layer > 1,
      );
      const deploymentPosition = finalizeDeploymentPosition({
        positionSize: input.positionSize,
        positionMode: input.positionMode,
      });
      const resolvedPositionSize = deploymentPosition.value;
      const webhookSecret = generateWebhookSecret();
      const initialMartinState: Record<string, unknown> = {
        lossCount: 0,
        currentLot: resolvedPositionSize,
        lastEntryPrice: 0,
        ...(v40Config ? { __v35Config: v40Config } : {}),
        ...(input.v50Config ? { __v50Config: input.v50Config } : {}),
        ...(input.v61Config ? { __v61Config: input.v61Config } : {}),
        ...(rainbow20415Config ? { __v2_0Config: rainbow20415Config } : {}),
        ...(rainbowTrendLadderConfig ? { __rainbowTrendLadderConfig: rainbowTrendLadderConfig } : {}),
        ...(input.v70Config ? { __v70Config: input.v70Config } : {}),
        ...(v25Config ? { __v25Config: v25Config } : {}),
      };
      const v41Columns = v41Config ? deriveV41StrategyColumns(v41Config) : undefined;
      const martinState = v41Config
        ? attachV41StrategyConfig(initialMartinState, v41Config, "策略建立配置")
        : initialMartinState;
      const insertResult: any = await db.createStrategy({
        userId: ctx.user.id,
        name: input.name,
        description: input.description,
        apiKeyId: input.apiKeyId,
        exchange: keyRecord.exchange,
        symbol: input.symbol.toUpperCase(),
        ...deploymentPositionColumns(deploymentPosition),
        leverage: input.leverage,
        direction: input.direction,
        orderType: input.orderType,
        enabled: input.strategyKey === RAINBOW_TREND_LADDER_STRATEGY_KEY || input.strategyKey === V41_STRATEGY_KEY
          ? false
          : true,
        ...(input.strategyKey === V41_STRATEGY_KEY ? {
          disabledReason: "V4.1 新策略預設停用，請人工覆核後啟用",
        } : {}),
        webhookSecret,
        maxPositionPct: String(input.maxPositionPct),
        stopLossPct: v41Columns?.stopLossPct ?? String(v25Config?.Hard_Stop_Loss_Pct ?? input.stopLossPct),
        takeProfitPct: v41Columns?.takeProfitPct ?? String(v25Config?.Take_Profit_Pct ?? rainbow20415Config?.Take_Profit_Pct ?? rainbowTrendLadderConfig?.Trailing_Activation_Pct ?? input.takeProfitPct),
        maxDailyLoss: String(input.maxDailyLoss),
        martinMultiplier: v41Columns?.martinMultiplier ?? String(firstV25Range?.multiplier ?? firstRainbowRange?.multiplier ?? firstRainbowTrendAddLayer?.lotMultiplier ?? input.martinMultiplier),
        maxMartinLevel: v41Columns?.maxMartinLevel ?? (v25Config
          ? Math.max(1, deriveV25MaxMartinLayer(v25Config.Martin_Ranges))
          : rainbow20415Config
            ? Math.max(1, deriveRainbow20415FinalEnabledLayer(rainbow20415Config.Martin_Ranges))
            : rainbowTrendLadderConfig
              ? rainbowTrendLadderConfig.Max_Layers
              : input.maxMartinLevel),
        martinSpacingPct: v41Columns?.martinSpacingPct ?? String(firstV25Range?.gap ?? rainbow20415Config?.Global_Spacing_Pct ?? firstRainbowTrendAddLayer?.triggerSpacingPct ?? input.martinSpacingPct),
        martinState,
        strategyKey: input.strategyKey || null,
        ...(v25Config ? {
          kLinePeriod: v25Config.K_Line_Period,
          reentryEnabled: v25Config.Reentry_On_Trend,
        } : {}),
        ...(input.strategyKey === V40_STRATEGY_KEY ? {
          kLinePeriod: Number(v40Config?.K_Line_Period ?? 15),
          reentryEnabled: v40Config?.enableSameDirectionReentry ?? true,
        } : {}),
        ...(v41Columns ? {
          kLinePeriod: v41Columns.kLinePeriod,
          reentryEnabled: v41Columns.reentryEnabled,
        } : {}),
        ...(rainbow20415Config ? {
          kLinePeriod: rainbow20415Config.Entry_Timeframe_Minutes,
          reentryEnabled: rainbow20415Config.Reentry_Enabled,
        } : {}),
        ...(rainbowTrendLadderConfig ? {
          kLinePeriod: rainbowTrendLadderConfig.Entry_Timeframe_Minutes,
          reentryEnabled: rainbowTrendLadderConfig.Reentry_Wait_Next_M30_Close,
        } : {}),
      });
      // T3：回傳新建策略的 Webhook URL，供前端顯示成功引導彈窗
      const newId: number | undefined = insertResult?.[0]?.insertId;
      return {
        success: true,
        id: newId ?? null,
        name: input.name,
        exchange: keyRecord.exchange,
        symbol: input.symbol.toUpperCase(),
        webhookUrl: newId ? buildWebhookUrl(ctx.req, newId, webhookSecret) : null,
      };
    }),

  update: protectedProcedure
    .input(strategyInputSchema.partial().extend({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.getStrategyById(input.id, ctx.user.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }
      const targetStrategyKey = input.strategyKey ?? existing.strategyKey ?? "";
      if (
        (existing.strategyKey === V41_STRATEGY_KEY || targetStrategyKey === V41_STRATEGY_KEY)
        && existing.strategyKey !== targetStrategyKey
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "V4.1 策略引擎身份不可在既有實例上切換；請以顯式轉換草稿建立新實例",
        });
      }
      let v41Config: ReturnType<typeof resolveV41ConfigForStrategy>;
      try {
        assertV41ConfigIsolation(targetStrategyKey, {
          v25Config: input.v25Config,
          v35Config: input.v35Config,
          v50Config: input.v50Config,
          v61Config: input.v61Config,
          v70Config: input.v70Config,
          v2_0Config: input.v2_0Config,
          rainbowTrendLadderConfig: input.rainbowTrendLadderConfig,
        });
        v41Config = resolveV41ConfigForStrategy(targetStrategyKey, input.v41Config);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `V4.1 參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.symbol !== undefined) data.symbol = input.symbol.toUpperCase();
      if (input.positionSize !== undefined || input.positionMode !== undefined) {
        const currentDeploymentPosition = resolveDeploymentPosition(existing, {
          value: 1,
          mode: "quantity",
        });
        const deploymentPosition = finalizeDeploymentPosition({
          positionSize: input.positionSize,
          positionMode: input.positionMode,
        }, currentDeploymentPosition);
        Object.assign(data, deploymentPositionColumns(deploymentPosition));
      }
      if (input.leverage !== undefined) data.leverage = input.leverage;
      if (input.direction !== undefined) data.direction = input.direction;
      if (input.orderType !== undefined) data.orderType = input.orderType;
      if (input.maxPositionPct !== undefined) data.maxPositionPct = String(input.maxPositionPct);
      if (input.stopLossPct !== undefined) data.stopLossPct = String(input.stopLossPct);
      if (input.takeProfitPct !== undefined) data.takeProfitPct = String(input.takeProfitPct);
      if (input.maxDailyLoss !== undefined) data.maxDailyLoss = String(input.maxDailyLoss);
      if (input.martinMultiplier !== undefined) data.martinMultiplier = String(input.martinMultiplier);
      if (input.maxMartinLevel !== undefined) data.maxMartinLevel = input.maxMartinLevel;
      if (input.martinSpacingPct !== undefined) data.martinSpacingPct = String(input.martinSpacingPct);
      if (input.strategyKey !== undefined) data.strategyKey = input.strategyKey || null;
      if (v41Config) {
        const currentState = existing.martinState && typeof existing.martinState === "object"
          ? existing.martinState as Record<string, unknown>
          : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        data.martinState = attachV41StrategyConfig(currentState, v41Config, "策略編輯配置");
        Object.assign(data, deriveV41StrategyColumns(v41Config));
      }
      // V2.5：編輯時重用新增／回測／快照的同一嚴格契約，並保留既有持倉運行狀態。
      if (input.v25Config !== undefined) {
        let v25Config: ReturnType<typeof assertValidV25Config>;
        try {
          v25Config = assertValidV25Config(input.v25Config);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `V2.5 參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        const prevState =
          existing.martinState && typeof existing.martinState === "object"
            ? (existing.martinState as Record<string, unknown>)
            : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        const firstRange = v25Config.Martin_Ranges[0];
        data.martinState = { ...prevState, __v25Config: v25Config };
        data.stopLossPct = String(v25Config.Hard_Stop_Loss_Pct);
        data.takeProfitPct = String(v25Config.Take_Profit_Pct);
        data.martinMultiplier = String(firstRange?.multiplier ?? 1);
        data.maxMartinLevel = Math.max(1, deriveV25MaxMartinLayer(v25Config.Martin_Ranges));
        data.martinSpacingPct = String(firstRange?.gap ?? 0);
        data.kLinePeriod = v25Config.K_Line_Period;
        data.reentryEnabled = v25Config.Reentry_On_Trend;
      }
      // Pasted_content_21：更新 __v35Config（保留現有運行狀態如 lossCount/currentLot）
      if (input.v35Config !== undefined) {
        const targetStrategyKey = input.strategyKey ?? existing.strategyKey;
        const v40Config = targetStrategyKey === V40_STRATEGY_KEY
          ? {
              ...input.v35Config,
              ...normalizeV40EntryGateConfig(input.v35Config as Record<string, unknown>),
            }
          : input.v35Config;
        const layersErr = validateMartinLayersJson(v40Config.Martin_Layers ?? "");
        if (layersErr) throw new TRPCError({ code: "BAD_REQUEST", message: `階梯式馬丁分層設定錯誤：${layersErr}` });
        const prevState =
          existing.martinState && typeof existing.martinState === "object"
            ? (existing.martinState as Record<string, unknown>)
            : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        data.martinState = { ...prevState, __v35Config: v40Config };
        if (targetStrategyKey === V40_STRATEGY_KEY) {
          data.kLinePeriod = Number(v40Config.K_Line_Period ?? existing.kLinePeriod ?? 15);
          data.reentryEnabled = v40Config.enableSameDirectionReentry ?? true;
        }
      }
      // V5.0：更新 __v50Config（KAMA 3K 極致優化馬丁）
      if (input.v50Config !== undefined) {
        const prevState =
          existing.martinState && typeof existing.martinState === "object"
            ? (existing.martinState as Record<string, unknown>)
            : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        data.martinState = { ...prevState, __v50Config: input.v50Config };
      }
      // 20415 七彩虹：沿用穩定 __v2_0Config 儲存鍵，但內容必須經共享契約校驗。
      if (input.v2_0Config !== undefined) {
        const targetStrategyKey = input.strategyKey ?? existing.strategyKey;
        if (targetStrategyKey !== RAINBOW_20415_STRATEGY_KEY) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "v2_0Config 僅可用於 20415 七彩虹馬丁策略" });
        }
        let rainbow20415Config: ReturnType<typeof assertValidRainbow20415Config>;
        try {
          rainbow20415Config = assertValidRainbow20415Config(input.v2_0Config);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `20415 七彩虹參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        const prevState =
          data.martinState && typeof data.martinState === "object"
            ? (data.martinState as Record<string, unknown>)
            : existing.martinState && typeof existing.martinState === "object"
            ? (existing.martinState as Record<string, unknown>)
            : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        const firstRange = getRainbow20415RangeForLayer(rainbow20415Config.Martin_Ranges, 1);
        data.martinState = { ...prevState, __v2_0Config: rainbow20415Config };
        data.takeProfitPct = String(rainbow20415Config.Take_Profit_Pct);
        data.martinMultiplier = String(firstRange?.multiplier ?? 1);
        data.maxMartinLevel = Math.max(1, deriveRainbow20415FinalEnabledLayer(rainbow20415Config.Martin_Ranges));
        data.martinSpacingPct = String(rainbow20415Config.Global_Spacing_Pct);
        data.kLinePeriod = rainbow20415Config.Entry_Timeframe_Minutes;
        data.reentryEnabled = rainbow20415Config.Reentry_Enabled;
      }
      // 全新七彩虹線階梯：使用獨立設定鍵並保留自身 runtime，不讀寫 20415 的 __v2_0Config。
      if (input.rainbowTrendLadderConfig !== undefined) {
        const targetStrategyKey = input.strategyKey ?? existing.strategyKey;
        if (targetStrategyKey !== RAINBOW_TREND_LADDER_STRATEGY_KEY) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "rainbowTrendLadderConfig 僅可用於七彩虹線趨勢跟蹤階梯馬丁策略" });
        }
        let rainbowTrendLadderConfig: ReturnType<typeof assertValidRainbowTrendLadderConfig>;
        try {
          rainbowTrendLadderConfig = assertValidRainbowTrendLadderConfig(input.rainbowTrendLadderConfig);
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `七彩虹線階梯策略參數設定錯誤：${error instanceof Error ? error.message : String(error)}`,
          });
        }
        const prevState =
          data.martinState && typeof data.martinState === "object"
            ? (data.martinState as Record<string, unknown>)
            : existing.martinState && typeof existing.martinState === "object"
              ? (existing.martinState as Record<string, unknown>)
              : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        const firstAddLayer = rainbowTrendLadderConfig.Martin_Layers.find(
          (layer) => layer.enabled && layer.layer > 1,
        );
        data.martinState = { ...prevState, __rainbowTrendLadderConfig: rainbowTrendLadderConfig };
        data.takeProfitPct = String(rainbowTrendLadderConfig.Trailing_Activation_Pct);
        data.martinMultiplier = String(firstAddLayer?.lotMultiplier ?? 1);
        data.maxMartinLevel = rainbowTrendLadderConfig.Max_Layers;
        data.martinSpacingPct = String(firstAddLayer?.triggerSpacingPct ?? 0);
        data.kLinePeriod = rainbowTrendLadderConfig.Entry_Timeframe_Minutes;
        data.reentryEnabled = rainbowTrendLadderConfig.Reentry_Wait_Next_M30_Close;
      }
      // V6.1：更新 __v61Config（KAMA 3K 高頻掃射極致版）
      if (input.v61Config !== undefined) {
        const prevState =
          existing.martinState && typeof existing.martinState === "object"
            ? (existing.martinState as Record<string, unknown>)
            : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        data.martinState = { ...prevState, __v61Config: input.v61Config };
      }
      // V7.0：更新 __v70Config（龍捲風雙渦輪）
      if (input.v70Config !== undefined) {
        const prevState =
          existing.martinState && typeof existing.martinState === "object"
            ? (existing.martinState as Record<string, unknown>)
            : { lossCount: 0, currentLot: Number(existing.positionSize), lastEntryPrice: 0 };
        data.martinState = { ...prevState, __v70Config: input.v70Config };
      }
      if (input.apiKeyId !== undefined) {
        const keyRecord = await db.getApiKeyById(input.apiKeyId, ctx.user.id);
        if (!keyRecord) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "選擇的 API 金鑰不存在" });
        }
        data.apiKeyId = input.apiKeyId;
        data.exchange = keyRecord.exchange;
      }
      await db.updateStrategy(input.id, ctx.user.id, data);
      return { success: true };
    }),

  toggle: protectedProcedure
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.getStrategyById(input.id, ctx.user.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }
      await db.updateStrategy(input.id, ctx.user.id, {
        enabled: input.enabled,
        disabledReason: input.enabled ? null : "手動停用",
      });
      return { success: true };
    }),

  /** T2：策略狀態控制（running 恢復 / paused 暫停 / stopped 停止）
   * 適配現有 strategies 表：running → enabled=true；paused/stopped → enabled=false + 對應 disabledReason
   * stopped 額外重置馬丁狀態，確保下次啟動從初始倉位開始 */
  setStatus: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["running", "paused", "stopped"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.getStrategyById(input.id, ctx.user.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }
      const currentStatus = existing.enabled
        ? "running"
        : existing.disabledReason === "手動暫停"
          ? "paused"
          : "stopped";
      if (currentStatus === input.status) {
        return { success: true, message: `策略已是${statusLabel(input.status)}狀態`, newStatus: input.status };
      }
      const data: Record<string, unknown> = {};
      if (input.status === "running") {
        data.enabled = true;
        data.disabledReason = null;
      } else if (input.status === "paused") {
        data.enabled = false;
        data.disabledReason = "手動暫停";
      } else {
        data.enabled = false;
        data.disabledReason = "手動停止";
        // 停止時完整重置馬丁狀態（保留配置子鍵）
        const existingState = (existing.martinState && typeof existing.martinState === 'object')
          ? existing.martinState as Record<string, unknown>
          : {};
        const preserved = pickStrategyConfigState(existingState);
        data.martinState = {
          ...preserved,
          avgPrice: 0, capital: 0, cooldownUntil: 0, currentLayer: 0,
          currentLot: 0, entryTrendBull: false, hasTriggeredKamaReversal: false,
          highestPrice: 0, isCooldown: false, isLong: false, isTrailingActivated: false,
          lastEntryPrice: 0, lastLayerPrice: 0, lockedBarTimestamp: 0,
          lossCount: 0, lowestPrice: 0, totalCost: 0, totalSize: 0,
        };
      }
      await db.updateStrategy(input.id, ctx.user.id, data);
      return {
        success: true,
        message: `策略已${statusLabel(input.status)}`,
        newStatus: input.status,
      };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await db.deleteStrategy(input.id, ctx.user.id);
      return { success: true };
    }),

  // 強制重置策略狀態（適用所有策略）— 先平掉交易所殘留持倉，再清除 martinState
  resetMartinState: protectedProcedure
    .input(z.object({ id: z.number(), closeExchangePosition: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.getStrategyById(input.id, ctx.user.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }

      // === 步驟 1：軟隔離精確平倉（只平本策略記錄的 totalSize，不影響同帳戶其他策略）===
      let exchangeCloseMsg = "";
      if (input.closeExchangePosition) {
        const martinState = (existing.martinState ?? {}) as any;
        const strategyTotalSize = Number(martinState.totalSize) || 0;
        const strategyIsLong = martinState.isLong === true;

        if (strategyTotalSize > 0) {
          try {
            const keyRecord = await db.getApiKeyById(existing.apiKeyId);
            if (keyRecord) {
              const adapter = createAdapter(keyRecord);
              const closeSide = strategyIsLong ? "sell" : "buy";
              const posSide: "long" | "short" = strategyIsLong ? "long" : "short";
              console.log(`[resetMartinState][SoftIsolation] 策略 ${existing.id} 精確平倉: ${existing.symbol} ${posSide} size=${strategyTotalSize}`);
              const result = await adapter.placeOrder({
                symbol: existing.symbol,
                side: closeSide,
                orderType: "market",
                size: strategyTotalSize,
                reduceOnly: true,
                posSide: posSide,
              });
              if (result.success) {
                exchangeCloseMsg = `已精確平倉 ${posSide} ${strategyTotalSize}; `;
              } else {
                exchangeCloseMsg = `精確平倉失敗: ${result.errorMessage}; `;
              }
            }
          } catch (e: any) {
            console.warn(`[resetMartinState] 平倉嘗試失敗（不影響狀態重置）：${e.message}`);
            exchangeCloseMsg = `平倉查詢失敗: ${e.message}; `;
          }
        } else {
          exchangeCloseMsg = "本策略無持倉記錄，無需平倉; ";
        }
      }

      // === 步驟 2：清除該策略的所有 Bar-Lock 記錄（避免重置後被攞截無法重新開倉）===
      try {
        const { releaseAllLocks } = await import("./services/barLock");
        await releaseAllLocks(input.id);
        console.log(`[resetMartinState] 策略 ${existing.id} 已清除所有 Bar-Lock 記錄`);
      } catch (e: any) {
        console.warn(`[resetMartinState] 清除 Bar-Lock 失敗（不影響狀態重置）：${e.message}`);
      }

      // === 步驟 3：重置本地 martinState（保留配置子鍵）===
      const existingState = (existing.martinState && typeof existing.martinState === 'object')
        ? existing.martinState as Record<string, unknown>
        : {};
      const configKeys = ['__v35Config', '__v50Config', '__v61Config', '__v2_0Config', '__v70Config'];
      const preserved: Record<string, unknown> = {};
      for (const key of configKeys) {
        if (existingState[key] !== undefined) preserved[key] = existingState[key];
      }
      const resetState = {
        ...preserved,
        avgPrice: 0, capital: 0, cooldownUntil: 0, currentLayer: 0,
        currentLot: 0, entryTrendBull: false, hasTriggeredKamaReversal: false,
        highestPrice: 0, isCooldown: false, isLong: false, isTrailingActivated: false,
        lastEntryPrice: 0, lastLayerPrice: 0, lockedBarTimestamp: 0,
        lossCount: 0, lowestPrice: 0, totalCost: 0, totalSize: 0,
      };
      await db.updateStrategy(input.id, ctx.user.id, { martinState: resetState });
      console.log(`[resetMartinState] 策略 ${existing.id} 狀態已重置。${exchangeCloseMsg}`);
      return {
        success: true,
        message: `${exchangeCloseMsg}策略狀態已重置（含清除 Bar-Lock），下次輪詢將從首單開倉開始`,
      };
    }),

  regenerateSecret: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.getStrategyById(input.id, ctx.user.id);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }
      const secret = generateWebhookSecret();
      await db.updateStrategy(input.id, ctx.user.id, { webhookSecret: secret });
      return {
        success: true,
        secret,
        webhookUrl: buildWebhookUrl(ctx.req, input.id, secret),
      };
    }),

  /** T2：手動平倉（軟隔離：按策略記錄的精確數量下反向單，不影響同帳戶其他策略的持倉）
   * 平倉成功後：重置馬丁狀態 + 自動暫停策略（防止立即重新開倉）+ 記錄交易 */
  closePosition: protectedProcedure
    .input(z.object({ id: z.number(), pauseAfterClose: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const strategy = await db.getStrategyById(input.id, ctx.user.id);
      if (!strategy) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }
      const keyRecord = await db.getApiKeyById(strategy.apiKeyId);
      if (!keyRecord) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "API 金鑰不存在" });
      }
      const adapter = createAdapter(keyRecord);

      // === 軟隔離核心：從策略 martinState 讀取精確持倉數量，下反向單平倉 ===
      const martinState = (strategy.martinState ?? {}) as any;
      const strategyTotalSize = Number(martinState.totalSize) || 0;
      const strategyIsLong = martinState.isLong === true;
      const strategyCurrentLayer = Number(martinState.currentLayer) || 0;

      // 如果策略本地記錄無持倉，先查詢交易所確認
      if (strategyTotalSize <= 0 || strategyCurrentLayer === 0) {
        // 本地無持倉記錄，查詢交易所確認
        try {
          const positions = await adapter.getPositions(strategy.symbol);
          const activePos = positions.filter((p) => p.size > 0);
          if (activePos.length === 0) {
            // 交易所也確認無持倉，重置狀態即可
            await db.updateStrategy(strategy.id, ctx.user.id, {
              martinState: {
                ...martinState,
                lossCount: 0, currentLot: parseFloat(strategy.positionSize ?? '0'),
                lastEntryPrice: 0, currentLayer: 0, totalSize: 0, avgPrice: 0,
                isTrailingActivated: false,
              },
            });
            return { success: true, message: `${strategy.symbol} 本策略無持倉記錄，交易所也確認無持倉` };
          }
        } catch (e: any) {
          console.warn(`[closePosition] 查詢交易所持倉失敗: ${e?.message}`);
        }
        return { success: false, message: `${strategy.symbol} 本策略無持倉記錄（totalSize=0），無法平倉` };
      }

      // === 精確平倉：用 placeOrder 下反向市價單，數量 = 策略記錄的 totalSize ===
      const closeSide = strategyIsLong ? "sell" : "buy";
      const posSide: "long" | "short" = strategyIsLong ? "long" : "short";
      console.log(`[closePosition][SoftIsolation] 策略 ${strategy.id} 精確平倉: ${strategy.symbol} ${posSide} size=${strategyTotalSize} closeSide=${closeSide}`);

      const result = await adapter.placeOrder({
        symbol: strategy.symbol,
        side: closeSide,
        orderType: "market",
        size: strategyTotalSize,
        reduceOnly: true,
        posSide: posSide,
      });

      const closedSides: string[] = [];
      let lastError = "";
      if (result.success) {
        closedSides.push(posSide);
        await recordExistingTradeExecution({
          strategyId: strategy.id,
          userId: ctx.user.id,
          exchange: strategy.exchange,
          symbol: strategy.symbol,
          side: closeSide,
          orderType: "market",
          orderId: result.orderId,
          size: String(strategyTotalSize),
          exchangeResult: result,
          reduceOnly: true,
          status: "filled",
          triggerSource: "manual",
        });
      } else {
        lastError = result.errorMessage || "平倉失敗";
        console.error(`[closePosition][SoftIsolation] 策略 ${strategy.id} 精確平倉失敗:`, result.rawResponse);
        
        // ─── 核心修復：當 OKX 返回 51169（無持倉可平）時，自動重置本地狀態 ───
        // 場景：其他策略已將本策略的持倉平掉，或用戶在 OKX 手動平倉
        const rawResp = result.rawResponse ? JSON.stringify(result.rawResponse) : '';
        if (rawResp.includes('51169') || (result.errorMessage && result.errorMessage.includes('51169'))) {
          console.log(`[closePosition] 策略 ${strategy.id} OKX 51169 無持倉可平，自動重置本地狀態`);
          // 視為平倉成功（因為交易所確認無持倉）
          closedSides.push(posSide);
          lastError = '';
        }
      }

      // 寫入訊號日誌（包含 orderId 以便與交易記錄連接）
      try {
        await db.createSignal({
          strategyId: strategy.id,
          userId: ctx.user.id,
          orderId: closedSides.length > 0 ? result?.orderId : undefined,
          rawPayload: JSON.stringify({
            action: "close",
            symbol: strategy.symbol,
            sides: closedSides,
            source: "manual_close",
            softIsolation: true,
            strategyTotalSize,
            pauseAfterClose: input.pauseAfterClose,
          }),
          parsedAction: "close",
          parsedSymbol: strategy.symbol,
          parsedPrice: String(martinState.avgPrice || 0),
          status: closedSides.length > 0 ? "executed" : "failed",
          message: closedSides.length > 0
            ? `[手動平倉] ${strategy.symbol} ${posSide} 精確平倉 ${strategyTotalSize}（不影響同帳戶其他策略）${input.pauseAfterClose ? "，策略已自動暫停" : ""}`
            : `[手動平倉] 失敗: ${lastError}`,
          source: "manual",
        });
      } catch (e) {
        console.error("[closePosition] 寫入訊號日誌失敗", e);
      }

      // 平倉成功後重置馬丁狀態 + 清除 Bar-Lock
      if (closedSides.length > 0) {
        const data: Record<string, unknown> = {
          martinState: {
            ...martinState,
            lossCount: 0,
            currentLot: parseFloat(strategy.positionSize ?? '0'),
            lastEntryPrice: 0,
            currentLayer: 0,
            totalSize: 0,
            avgPrice: 0,
            isTrailingActivated: false,
            lockedBarTimestamp: 0,
          },
        };
        if (input.pauseAfterClose) {
          data.enabled = false;
          data.disabledReason = "手動暫停";
        }
        await db.updateStrategy(strategy.id, ctx.user.id, data);
        // 清除該策略的所有 Bar-Lock 記錄，允許重新開倉
        try {
          const { releaseAllLocks } = await import("./services/barLock");
          await releaseAllLocks(strategy.id);
          console.log(`[closePosition] 策略 ${strategy.id} 已清除所有 Bar-Lock 記錄`);
        } catch (e: any) {
          console.warn(`[closePosition] 清除 Bar-Lock 失敗：${e.message}`);
        }
      }

      // Telegram 通知
      const closeSuccess = closedSides.length > 0;
      try {
        await telegramNotifier.sendClosePositionNotification({
          strategyId: strategy.id,
          strategyName: strategy.name,
          symbol: strategy.symbol,
          success: closeSuccess,
          closedSides,
          errorMessage: closeSuccess ? undefined : lastError,
          paused: input.pauseAfterClose,
        });
      } catch (e) {
        console.error("[closePosition] Telegram 通知發送失敗", e);
      }

      return {
        success: closeSuccess,
        message: closeSuccess
          ? `精確平倉已執行（${strategy.symbol} ${posSide} ${strategyTotalSize}，不影響同帳戶其他策略）${input.pauseAfterClose ? "，策略已自動暫停" : ""}`
          : lastError || "平倉失敗",
        exchangeError: closeSuccess ? undefined : lastError,
      };
    }),

  /** T2 補充：緊急全平倉——對所有策略執行真實交易所平倉，並暫停全部策略 */
  emergencyCloseAll: protectedProcedure.mutation(async ({ ctx }) => {
    const all = await db.listStrategies(ctx.user.id);
    const results: { strategyId: number; name: string; symbol: string; success: boolean; message: string }[] = [];
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    for (const strategy of all) {
      const keyRecord = await db.getApiKeyById(strategy.apiKeyId);
      if (!keyRecord) {
        failCount++;
        results.push({ strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol, success: false, message: "API 金鑰不存在" });
        continue;
      }
      try {
        const adapter = createAdapter(keyRecord);
        const positions = await adapter.getPositions(strategy.symbol);
        const activePositions = positions.filter((p) => p.size > 0);
        if (activePositions.length === 0) {
          skippedCount++;
          results.push({ strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol, success: true, message: "無持倉，跳過" });
        } else {
          let strategyCloseSuccess = true;
          for (const pos of activePositions) {
            const posSide = pos.side as "long" | "short";
            console.log(`[emergencyCloseAll] 策略 ${strategy.id} 平倉 ${strategy.symbol} posSide=${posSide}`);
            const result = await adapter.closePositionSmart(strategy.symbol, posSide);
            if (result.success) {
              await recordExistingTradeExecution({
                strategyId: strategy.id,
                userId: ctx.user.id,
                exchange: strategy.exchange,
                symbol: strategy.symbol,
                side: posSide === "long" ? "sell" : "buy",
                orderType: "market",
                orderId: result.orderId,
                size: String(pos.size),
                exchangeResult: result,
                reduceOnly: true,
                status: "filled",
                triggerSource: "manual",
              });
            } else {
              strategyCloseSuccess = false;
              console.error(`[emergencyCloseAll] 策略 ${strategy.id} 平倉失敗 posSide=${posSide}:`, result.rawResponse);
            }
          }
          if (strategyCloseSuccess) {
            successCount++;
            results.push({ strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol, success: true, message: "已市價平倉" });
          } else {
            failCount++;
            results.push({ strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol, success: false, message: "部分方向平倉失敗" });
          }
        }
        // 寫入訊號日誌（緊急全平倉）
        if (activePositions.length > 0) {
          try {
            const closePrice = activePositions[0].markPrice || 0;
            await db.createSignal({
              strategyId: strategy.id,
              userId: ctx.user.id,
              rawPayload: JSON.stringify({
                action: "emergency_close_all",
                symbol: strategy.symbol,
                sides: activePositions.map(p => p.side),
                source: "emergency_close_all",
              }),
              parsedAction: "close",
              parsedSymbol: strategy.symbol,
              parsedPrice: closePrice ? String(closePrice) : undefined,
              status: results[results.length - 1]?.success ? "executed" : "failed",
              message: results[results.length - 1]?.success
                ? `[緊急全平倉] ${strategy.symbol} 市價平倉成功，策略已暫停`
                : `[緊急全平倉] ${strategy.symbol} 部分方向平倉失敗`,
              source: "manual",
            });
          } catch (e) {
            console.error(`[emergencyCloseAll] 策略 ${strategy.id} 寫入訊號日誌失敗`, e);
          }
        }

        // 不論是否有持倉，均暫停策略並重置馬丁狀態，阻斷後續訊號自動開倉
        const existingMartinState = (strategy.martinState ?? {}) as any;
        await db.updateStrategy(strategy.id, ctx.user.id, {
          enabled: false,
          disabledReason: "緊急全平倉",
          martinState: {
            ...existingMartinState,
            lossCount: 0,
            currentLot: parseFloat(strategy.positionSize ?? '0'),
            lastEntryPrice: 0,
            currentLayer: 0,
            totalSize: 0,
            avgPrice: 0,
            isTrailingActivated: false,
          },
        });
      } catch (e: any) {
        failCount++;
        const msg = (e?.message || "未知錯誤").toString().replace(/[\n\r]/g, " ").slice(0, 300);
        results.push({ strategyId: strategy.id, name: strategy.name, symbol: strategy.symbol, success: false, message: msg });
      }
    }

    // Telegram 彙總通知（緊急全平倉結果）
    try {
      await telegramNotifier.sendEmergencyCloseAllNotification({
        successCount,
        failCount,
        skippedCount,
        results,
      });
    } catch (e) {
      console.error("[emergencyCloseAll] Telegram 通知發送失敗", e);
    }

    return {
      success: failCount === 0,
      message: `緊急全平倉完成：平倉 ${successCount} 個、無持倉跳過 ${skippedCount} 個、失敗 ${failCount} 個，全部策略已暫停`,
      successCount,
      failCount,
      skippedCount,
      results,
    };
  }),

  /**
   * 導出策略的完整交易數據（支援 CSV / JSON / cycle_report 格式）
   */
  exportData: protectedProcedure
    .input(
      z.object({
        strategyId: z.number(),
        format: z.enum(["json", "csv", "cycle_report"]).default("json"),
        // 篩選條件
        status: z.string().optional(),
        source: z.string().optional(),
        side: z.string().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const strategy = await db.getStrategyById(input.strategyId, ctx.user.id);
      if (!strategy) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }

      const allTrades = await db.listTrades(ctx.user.id, {
        strategyId: input.strategyId,
        startTime: input.startTime,
        endTime: input.endTime,
        limit: 10000,
      });
      const signalResult = await db.listSignals(ctx.user.id, {
        strategyId: input.strategyId,
        status: input.status,
        source: input.source,
        startTime: input.startTime,
        endTime: input.endTime,
        limit: 10000,
      });
      const allSignals = signalResult.items || signalResult;

      // --- 循環報告模式：按開倉→平倉配對 ---
      if (input.format === "cycle_report") {
        const sortedTrades = [...allTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const cycles: Array<{
          cycleNo: number;
          symbol: string;
          direction: string;
          openTime: string;
          closeTime: string;
          entryPrice: number;
          exitPrice: number;
          totalSize: number;
          layers: number;
          holdingMinutes: number;
          pnl: number;
          pnlPercent: number;
          closeReason: string;
        }> = [];

        let currentCycle: typeof sortedTrades = [];
        let cycleNo = 0;

        for (const trade of sortedTrades) {
          if (!trade.reduceOnly) {
            // 開倉/加倉
            currentCycle.push(trade);
          } else {
            // 平倉 → 結束一個循環
            if (currentCycle.length > 0) {
              cycleNo++;
              const entries = currentCycle;
              const totalEntrySize = entries.reduce((s, t) => s + parseFloat(t.size || "0"), 0);
              const weightedAvgPrice = totalEntrySize > 0
                ? entries.reduce((s, t) => s + parseFloat(t.price || "0") * parseFloat(t.size || "0"), 0) / totalEntrySize
                : 0;
              const exitPrice = parseFloat(trade.price || "0");
              const direction = entries[0]?.side === "buy" ? "LONG" : "SHORT";
              const dirMultiplier = direction === "LONG" ? 1 : -1;
              const pnl = (exitPrice - weightedAvgPrice) * totalEntrySize * dirMultiplier;
              const pnlPercent = weightedAvgPrice > 0 ? (pnl / (weightedAvgPrice * totalEntrySize)) * 100 : 0;
              const openTime = entries[0]?.createdAt;
              const closeTime = trade.createdAt;
              const holdingMs = new Date(closeTime).getTime() - new Date(openTime).getTime();

              cycles.push({
                cycleNo,
                symbol: strategy.symbol,
                direction,
                openTime: new Date(openTime).toISOString(),
                closeTime: new Date(closeTime).toISOString(),
                entryPrice: parseFloat(weightedAvgPrice.toFixed(6)),
                exitPrice: parseFloat(exitPrice.toFixed(6)),
                totalSize: parseFloat(totalEntrySize.toFixed(8)),
                layers: entries.length,
                holdingMinutes: Math.round(holdingMs / 60000),
                pnl: parseFloat(pnl.toFixed(4)),
                pnlPercent: parseFloat(pnlPercent.toFixed(2)),
                closeReason: trade.triggerSource || "unknown",
              });
            }
            currentCycle = [];
          }
        }

        // 統計
        const totalCycles = cycles.length;
        const winCycles = cycles.filter(c => c.pnl > 0).length;
        const lossCycles = cycles.filter(c => c.pnl < 0).length;
        const totalPnl = cycles.reduce((s, c) => s + c.pnl, 0);
        const winRate = totalCycles > 0 ? (winCycles / totalCycles) * 100 : 0;
        const avgPnl = totalCycles > 0 ? totalPnl / totalCycles : 0;
        const maxWin = cycles.length > 0 ? Math.max(...cycles.map(c => c.pnl)) : 0;
        const maxLoss = cycles.length > 0 ? Math.min(...cycles.map(c => c.pnl)) : 0;
        const avgHoldingMin = totalCycles > 0 ? Math.round(cycles.reduce((s, c) => s + c.holdingMinutes, 0) / totalCycles) : 0;

        // CSV 格式
        const header = "循環#,幣種,方向,開倉時間,平倉時間,均價,平倉價,數量,層數,持倉(分鐘),盈虧(USDT),盈虧%,平倉原因";
        const rows = cycles.map(c =>
          `${c.cycleNo},${c.symbol},${c.direction},${c.openTime},${c.closeTime},${c.entryPrice},${c.exitPrice},${c.totalSize},${c.layers},${c.holdingMinutes},${c.pnl},${c.pnlPercent}%,${c.closeReason}`
        );
        const summary = [
          "",
          `# 循環報告摘要`,
          `策略,${strategy.name}`,
          `幣種,${strategy.symbol}`,
          `總循環數,${totalCycles}`,
          `勝率,${winRate.toFixed(1)}%`,
          `總盈虧,${totalPnl.toFixed(4)} USDT`,
          `平均盈虧,${avgPnl.toFixed(4)} USDT`,
          `最大單筆盈利,${maxWin.toFixed(4)} USDT`,
          `最大單筆虧損,${maxLoss.toFixed(4)} USDT`,
          `平均持倉時間,${avgHoldingMin} 分鐘`,
          `勝/負,${winCycles}/${lossCycles}`,
        ];
        const csvString = "\uFEFF" + [header, ...rows, ...summary].join("\n");
        return { data: csvString, format: "cycle_report" };
      }

      // --- CSV 格式：真正的 CSV ---
      if (input.format === "csv") {
        // 用 signals 作為主要數據源（含 trades join 的 realizedPnl）
        const signalItems = Array.isArray(allSignals) ? allSignals : (allSignals as any)?.items ?? [];
        // 篩選 side
        let filteredSignals = signalItems;
        if (input.side && input.side !== "all") {
          const sideMap: Record<string, string[]> = { long: ["buy"], short: ["sell"] };
          const allowedActions = sideMap[input.side] || [input.side];
          filteredSignals = filteredSignals.filter((s: any) => allowedActions.includes(s.parsedAction));
        }

        const header = "時間,幣種,動作,價格,狀態,來源,訊息,盈虧(USDT)";
        const rows = filteredSignals.map((s: any) => {
          const time = s.createdAt ? new Date(s.createdAt).toISOString() : "";
          const symbol = s.parsedSymbol || strategy.symbol;
          const action = s.parsedAction || "";
          const price = s.parsedPrice || "";
          const status = s.status || "";
          const source = s.source || "";
          // 清理訊息中的逗號和換行
          const msg = (s.message || "").replace(/[,\n\r]/g, " ").substring(0, 200);
          const pnl = s.realizedPnl || "";
          return `${time},${symbol},${action},${price},${status},${source},"${msg}",${pnl}`;
        });

        // 統計摘要
        const totalSignals = filteredSignals.length;
        const executedCount = filteredSignals.filter((s: any) => s.status === "executed").length;
        const failedCount = filteredSignals.filter((s: any) => s.status === "failed").length;
        const summary = [
          "",
          `# 匯出摘要`,
          `策略,${strategy.name}`,
          `幣種,${strategy.symbol}`,
          `總訊號數,${totalSignals}`,
          `已執行,${executedCount}`,
          `失敗,${failedCount}`,
        ];

        const csvString = "\uFEFF" + [header, ...rows, ...summary].join("\n");
        return { data: csvString, format: "csv" };
      }

      // --- JSON 格式（含循環配對統計）---
      const sortedTrades = [...allTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      let currentCycle: typeof sortedTrades = [];
      let winCount = 0;
      let lossCount = 0;
      let totalPnlCalc = 0;

      for (const trade of sortedTrades) {
        if (!trade.reduceOnly) {
          currentCycle.push(trade);
        } else {
          if (currentCycle.length > 0) {
            const entries = currentCycle;
            const totalEntrySize = entries.reduce((s, t) => s + parseFloat(t.size || "0"), 0);
            const weightedAvgPrice = totalEntrySize > 0
              ? entries.reduce((s, t) => s + parseFloat(t.price || "0") * parseFloat(t.size || "0"), 0) / totalEntrySize
              : 0;
            const exitPrice = parseFloat(trade.price || "0");
            const direction = entries[0]?.side === "buy" ? 1 : -1;
            const pnl = (exitPrice - weightedAvgPrice) * totalEntrySize * direction;
            if (pnl > 0) winCount++;
            else if (pnl < 0) lossCount++;
            totalPnlCalc += pnl;
          }
          currentCycle = [];
        }
      }

      const totalCycles = winCount + lossCount;
      const winRate = totalCycles > 0 ? (winCount / totalCycles) * 100 : 0;

      const exportData = {
        strategy: {
          id: strategy.id,
          name: strategy.name,
          symbol: strategy.symbol,
          positionMode: strategy.positionMode,
          positionSize: strategy.positionSize,
          enabled: strategy.enabled,
        },
        statistics: {
          totalTrades: allTrades.length,
          totalCycles,
          winTrades: winCount,
          lossTrades: lossCount,
          winRate: parseFloat(winRate.toFixed(2)),
          totalRealizedPnl: parseFloat(totalPnlCalc.toFixed(4)),
          avgRealizedPnl: totalCycles > 0 ? parseFloat((totalPnlCalc / totalCycles).toFixed(4)) : 0,
        },
        trades: allTrades,
        signals: allSignals,
      };

      return { data: exportData, format: input.format };
    }),

  /**
   * 🔥 方案 B：與交易所同步持倉數據
   * 用 OKX/Bybit 實際持倉的 entryPrice/size 覆蓋本地 martinState
   */
  syncWithExchange: protectedProcedure
    .input(z.object({ strategyId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const strategy = await db.getStrategyById(input.strategyId, ctx.user.id);
      if (!strategy) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }
      const keyRecord = await db.getApiKeyById(strategy.apiKeyId);
      if (!keyRecord) {
        throw new TRPCError({ code: "NOT_FOUND", message: "API 金鑰不存在" });
      }
      const adapter = createAdapter(keyRecord);
      const positions = await adapter.getPositions(strategy.symbol);

      // 讀取本地狀態
      const { loadStrategyState, saveStrategyState } = await import("./services/strategyStateManager");
      const localState = loadStrategyState(strategy);
      const expectedSide = localState.isLong ? "long" : "short";

      // 找到對應方向的持倉
      const myPos = positions.find((p) => p.size > 0 && p.side === expectedSide);
      if (!myPos) {
        if (localState.totalSize > 0) {
          return {
            success: false,
            message: `交易所無 ${expectedSide} 方向持倉，但本地記錄有 ${localState.totalSize}。如確認已平倉，請使用「平倉」按鈕重置狀態。`,
          };
        }
        return { success: true, message: "交易所無持倉，本地也無持倉，無需同步" };
      }

      const exchangeSize = myPos.size;
      const exchangeAvgPrice = myPos.entryPrice;
      const exchangeMarkPrice = myPos.markPrice;

      const sizeDiff = Math.abs(exchangeSize - localState.totalSize);
      const priceDiff = Math.abs(exchangeAvgPrice - localState.avgPrice);

      const updatedState = {
        ...localState,
        totalSize: exchangeSize,
        avgPrice: exchangeAvgPrice,
        totalCost: exchangeSize * exchangeAvgPrice,
        currentLayer: localState.currentLayer > 0 ? localState.currentLayer : 1,
      };
      await saveStrategyState(strategy.id, updatedState);

      return {
        success: true,
        message: `同步完成！持倉量: ${localState.totalSize} → ${exchangeSize}，均價: ${localState.avgPrice.toFixed(2)} → ${exchangeAvgPrice.toFixed(2)}`,
        details: {
          before: { size: localState.totalSize, avgPrice: localState.avgPrice },
          after: { size: exchangeSize, avgPrice: exchangeAvgPrice },
          sizeDiff,
          priceDiff,
          exchangeMarkPrice,
        },
      };
    }),
});

function statusLabel(status: "running" | "paused" | "stopped"): string {
  return status === "running" ? "恢復運行" : status === "paused" ? "暫停" : "停止";
}

/* ==================== 訊號日誌路由 ==================== */

const signalsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        strategyId: z.number().optional(),
        status: z.enum(["received", "executed", "failed", "rejected", "skipped"]).optional(),
        source: z.enum(["webhook", "auto", "manual"]).optional(),
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return tradeJournalRouter.createCaller(ctx).list(input);
    }),

  /** 任務 3.4：發送測試信號，驗證訊號接收鏈（不實際下單） */
  sendTestSignal: protectedProcedure
    .input(z.object({ strategyId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const strategy = await db.getStrategyById(input.strategyId, ctx.user.id);
      if (!strategy) {
        throw new TRPCError({ code: "NOT_FOUND", message: "策略不存在" });
      }
      const testPayload = {
        action: "buy",
        symbol: strategy.symbol,
        price: 0,
        timestamp: new Date().toISOString(),
        isTest: true,
        note: "模擬 BUY 信號（測試用，未實際下單）",
      };
      await db.createSignal({
        strategyId: strategy.id,
        userId: ctx.user.id,
        rawPayload: JSON.stringify(testPayload),
        parsedAction: "buy",
        parsedSymbol: strategy.symbol,
        status: "executed",
        source: "manual",
        message: "✅ 測試信號成功路由（模擬 BUY，未實際下單）",
        latencyMs: 1,
      });
      return {
        success: true,
        message: "測試信號已發送，請查看訊號日誌",
        testPayload,
      };
    }),
});

/* ==================== 儀表板路由 ==================== */

const dashboardRouter = router({
  /** 各交易所帳戶餘額與持倉總覽 */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const keys = await db.listApiKeys(ctx.user.id);
    const accounts: {
      apiKeyId: number;
      label: string;
      exchange: string;
      isTestnet: boolean;
      balance: { free: number; total: number; unrealizedPnl: number; usedMargin: number } | null;
      positions: {
        symbol: string;
        side: string;
        size: number;
        entryPrice: number;
        markPrice: number;
        unrealizedPnl: number;
        leverage: number;
        positionMargin?: number;
        unrealizedPnlRatioPct?: number;
        updatedAt?: number;
        liquidationPrice?: number;
        marginRatio?: number;
      }[];
      positionSnapshotContract: string;
      positionSnapshotCapturedAt: number | null;
      error: string | null;
    }[] = [];

    await Promise.all(
      keys.map(async (k) => {
        const entry: (typeof accounts)[number] = {
          apiKeyId: k.id,
          label: k.label,
          exchange: k.exchange,
          isTestnet: k.isTestnet,
          balance: null,
          positions: [],
          positionSnapshotContract: "exchange-position-v2",
          positionSnapshotCapturedAt: null,
          error: null,
        };
        try {
          const adapter = createAdapter(k);
          const [balance, positionSnapshot] = await Promise.all([
            adapter.getBalance(),
            getAccountPositionSnapshot(ctx.user.id, k),
          ]);
          entry.balance = {
            free: balance.free,
            total: balance.total,
            unrealizedPnl: balance.unrealizedPnl,
            usedMargin: balance.usedMargin ?? 0,
          };
          entry.positions = positionSnapshot.positions;
          entry.positionSnapshotContract = positionSnapshot.contractVersion;
          entry.positionSnapshotCapturedAt = positionSnapshot.capturedAt;
          if (positionSnapshot.error) entry.error = positionSnapshot.error;
        } catch (e: any) {
          entry.error = e.message;
        }
        accounts.push(entry);
      }),
    );

    // 今日統計（訊號數與已實現盈虧）
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayTrades = await db.listTrades(ctx.user.id, {
      startTime: todayStart,
      limit: 1000,
    });
    const todayRealizedPnl = todayTrades.reduce(
      (sum, t) => sum + parseFloat(t.realizedPnl ?? "0"),
      0,
    );

    const userStrategies = await db.listStrategies(ctx.user.id);

    return {
      accounts,
      todayTradeCount: todayTrades.length,
      todayRealizedPnl,
      strategyCount: userStrategies.length,
      enabledStrategyCount: userStrategies.filter((s) => s.enabled).length,
    };
  }),

  riskEvents: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20), offset: z.number().min(0).default(0) }).optional())
    .query(async ({ ctx, input }) => {
      return db.listRiskEvents(ctx.user.id, input?.limit ?? 20, input?.offset ?? 0);
    }),
});

/* ==================== 績效統計路由 ==================== */

const performanceRouter = router({
  byStrategy: protectedProcedure
    .input(
      z.object({
        startTime: z.date().optional(),
        endTime: z.date().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const userStrategies = await db.listStrategies(ctx.user.id);
      const allTrades = await db.listTrades(ctx.user.id, {
        startTime: input.startTime,
        endTime: input.endTime,
        limit: 5000,
      });

      return userStrategies.map((s) => {
        const strategyTrades = allTrades.filter((t) => t.strategyId === s.id);
        const summary = summarizeStrategyPerformance(strategyTrades);

        return {
          strategyId: s.id,
          strategyName: s.name,
          symbol: s.symbol,
          exchange: s.exchange,
          enabled: s.enabled,
          tradeCount: strategyTrades.length,
          closedTradeCount: summary.closedTradeCount,
          winRate: summary.closedTradeCount > 0
            ? (summary.wins / summary.closedTradeCount) * 100
            : 0,
          totalPnl: summary.totalPnl,
          maxDrawdown: summary.maxDrawdown,
        };
      });
    }),

  trades: protectedProcedure
    .input(
      z.object({
        strategyId: z.number().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
        limit: z.number().min(1).max(500).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      return db.listTrades(ctx.user.id, input);
    }),

  /** 回填歷史平倉交易的 realizedPnl（一次性運行） */
  backfillPnl: protectedProcedure.mutation(async ({ ctx }) => {
    const database = await db.getDb();
    if (!database) throw new Error("資料庫不可用");

    // Find close trades with no realizedPnl
    const closeTrades = await database.execute(
      sql`SELECT id, strategyId, symbol, side, orderId, size, price, createdAt 
          FROM trades 
          WHERE reduceOnly = 1 AND realizedPnl IS NULL AND userId = ${ctx.user.id}
          ORDER BY createdAt DESC`
    );

    let updated = 0;
    let skipped = 0;
    const rows = (closeTrades as any)[0] || closeTrades;
    const tradeRows = Array.isArray(rows) ? rows : [];

    for (const closeTrade of tradeRows) {
      // Find recent open trades for this strategy
      const openTrades = await database.execute(
        sql`SELECT side, size, price FROM trades 
            WHERE strategyId = ${closeTrade.strategyId}
              AND reduceOnly = 0 AND status = 'filled'
              AND createdAt < ${closeTrade.createdAt}
            ORDER BY createdAt DESC LIMIT 10`
      );

      const openRows = Array.isArray((openTrades as any)[0]) ? (openTrades as any)[0] : [];
      if (openRows.length === 0) { skipped++; continue; }

      const openSide = openRows[0].side;
      let totalSize = 0, totalCost = 0;
      for (const ot of openRows) {
        if (ot.side !== openSide) break;
        const s = parseFloat(ot.size || "0");
        const p = parseFloat(ot.price || "0");
        if (p > 0 && s > 0) { totalSize += s; totalCost += s * p; }
      }

      if (totalSize === 0 || totalCost === 0) { skipped++; continue; }
      const avgEntryPrice = totalCost / totalSize;

      // Get close price
      let closePrice = parseFloat(closeTrade.price || "0");
      if (closePrice === 0) {
        // Try from signal
        const sigResult = await database.execute(
          sql`SELECT parsedPrice FROM signals 
              WHERE strategyId = ${closeTrade.strategyId}
                AND parsedAction = 'close' AND status = 'executed'
                AND createdAt BETWEEN DATE_SUB(${closeTrade.createdAt}, INTERVAL 10 SECOND) 
                AND DATE_ADD(${closeTrade.createdAt}, INTERVAL 10 SECOND)
              ORDER BY ABS(TIMESTAMPDIFF(SECOND, createdAt, ${closeTrade.createdAt})) ASC
              LIMIT 1`
        );
        const sigRows = Array.isArray((sigResult as any)[0]) ? (sigResult as any)[0] : [];
        if (sigRows.length > 0 && sigRows[0].parsedPrice) {
          closePrice = parseFloat(sigRows[0].parsedPrice);
        }
      }

      if (closePrice === 0) { skipped++; continue; }

      // Calculate PnL
      const isLong = openSide === "buy";
      const priceDiff = isLong ? (closePrice - avgEntryPrice) : (avgEntryPrice - closePrice);
      const pnl = priceDiff * totalSize;

      await database.execute(
        sql`UPDATE trades SET realizedPnl = ${pnl.toFixed(8)}, price = COALESCE(price, ${closePrice.toFixed(8)}) WHERE id = ${closeTrade.id}`
      );
      updated++;
    }

    // Step 2: Link close signals to close trades
    const unlinked = await database.execute(
      sql`SELECT t.id, t.strategyId, t.orderId, t.createdAt FROM trades t 
          WHERE t.reduceOnly = 1 AND t.signalId IS NULL AND t.userId = ${ctx.user.id}
          ORDER BY t.createdAt DESC`
    );
    const unlinkedRows = Array.isArray((unlinked as any)[0]) ? (unlinked as any)[0] : [];
    let linked = 0;

    for (const trade of unlinkedRows) {
      if (trade.orderId) {
        const byOrderId = await database.execute(
          sql`SELECT id FROM signals WHERE orderId = ${trade.orderId} LIMIT 1`
        );
        const byOrderIdRows = Array.isArray((byOrderId as any)[0]) ? (byOrderId as any)[0] : [];
        if (byOrderIdRows.length > 0) {
          await database.execute(
            sql`UPDATE trades SET signalId = ${byOrderIdRows[0].id} WHERE id = ${trade.id}`
          );
          linked++;
          continue;
        }
      }
      // Match by time proximity
      const byTime = await database.execute(
        sql`SELECT id FROM signals 
            WHERE strategyId = ${trade.strategyId}
              AND parsedAction = 'close' AND status = 'executed'
              AND createdAt BETWEEN DATE_SUB(${trade.createdAt}, INTERVAL 10 SECOND) 
              AND DATE_ADD(${trade.createdAt}, INTERVAL 10 SECOND)
            ORDER BY ABS(TIMESTAMPDIFF(SECOND, createdAt, ${trade.createdAt})) ASC
            LIMIT 1`
      );
      const byTimeRows = Array.isArray((byTime as any)[0]) ? (byTime as any)[0] : [];
      if (byTimeRows.length > 0) {
        await database.execute(
          sql`UPDATE trades SET signalId = ${byTimeRows[0].id} WHERE id = ${trade.id}`
        );
        linked++;
      }
    }

    return { updated, skipped, linked, total: tradeRows.length };
  }),
});

/* ==================== 策略工作室路由（模塊二） ==================== */

const studioRouter = router({
  /** 列出已註冊策略（內建 + 該用戶自訂） */
  list: protectedProcedure.query(async ({ ctx }) => {
    await initStrategyStudio();
    const registered = listRegisteredStrategies();
    const defs = await db.listStrategyDefinitions(ctx.user.id);
    // 合併：內建來自註冊中心，自訂來自 DB（含未載入成功的）
    const builtIns = registered.filter((s) => s.isBuiltIn);
    const customs = defs
      .filter((d) => !d.isBuiltIn)
      .map((d) => ({
        key: d.key,
        name: d.name,
        description: d.description ?? undefined,
        defaultConfig: (d.defaultConfig as Record<string, unknown>) ?? {},
        isBuiltIn: false,
        sourceType: d.sourceType,
        version: d.version,
        loaded: registered.some((r) => r.key === d.key),
        updatedAt: d.updatedAt,
      }));
    return [
      ...builtIns.map((b) => ({
        key: b.key,
        name: b.name,
        description: "系統內建策略，受保護禁止覆蓋與刪除",
        defaultConfig: b.defaultConfig,
        isBuiltIn: true,
        sourceType: "system" as const,
        version: 1,
        loaded: true,
        updatedAt: null as Date | null,
      })),
      ...customs,
    ];
  }),

  /** 馬丁倉位預覽表（V3.5 動態表單用） */
  previewMartinLayers: protectedProcedure
    .input(
      z.object({
        Initial_Capital: z.number(),
        First_Order_Pct: z.number(),
        Max_Loss_Pct: z.number(),
        Martin_Layers: z.array(z.object({
          start: z.number(),
          end: z.number(),
          multiplier: z.number(),
        })),
        Max_Layers: z.number().int().min(1),
        Martin_Step_Pct: z.number().min(0.01),
        Target_TP_Pct: z.number(),
        Callback_Pct: z.number(),
        K_Line_Period: z.number(),
      }),
    )
    .query(async ({ input }) => {
      const { MartingaleEngine } = await import("./services/martingaleEngine");
      const rows = MartingaleEngine.previewLayers({
        Initial_Capital: input.Initial_Capital,
        First_Order_Pct: input.First_Order_Pct,
        Max_Loss_Pct: input.Max_Loss_Pct,
        Martin_Step_Pct: input.Martin_Step_Pct,
        Martin_Layers: input.Martin_Layers,
        Max_Layers: input.Max_Layers,
        Target_TP_Pct: input.Target_TP_Pct,
        Callback_Pct: input.Callback_Pct,
        K_Line_Period: input.K_Line_Period,
        enableThreeKFilter: true,
        threeKPatternMode: "breakout",
        enableKamaDirectionLock: true,
        enableSameDirectionReentry: true,
      });
      return rows;
    }),

  /** 貼上或上傳代碼 → 編譯 → 註冊 → 持久化（熱重載，免重啟） */
  register: protectedProcedure
    .input(
      z.object({
        code: z.string().min(50).max(200_000),
        sourceType: z.enum(["paste", "upload"]).default("paste"),
        filename: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await initStrategyStudio();
      const result = await compileAndLoadStrategy(input.code, input.sourceType);
      if (!result.success) {
        throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
      }

      // 檢查 key 是否被其他用戶佔用
      const existing = await db.getStrategyDefinitionByKey(result.key!);
      if (existing && existing.userId !== ctx.user.id) {
        unregisterStrategy(result.key!);
        throw new TRPCError({
          code: "CONFLICT",
          message: `策略 key「${result.key}」已被其他用戶使用，請更換 key`,
        });
      }

      // V4.3: 自動產生 schemaConfig（從 defaultConfig 推斷欄位類型）
      const autoSchemaConfig = result.defaultConfig ? (() => {
        const fields: Record<string, any> = {};
        for (const [k, v] of Object.entries(result.defaultConfig as Record<string, any>)) {
          if (typeof v === 'number') {
            fields[k] = { key: k, type: 'number', label: k, default: v, step: v < 1 ? 0.01 : v < 10 ? 0.1 : 1 };
          } else if (typeof v === 'boolean') {
            fields[k] = { key: k, type: 'boolean', label: k, default: v };
          } else if (typeof v === 'string') {
            fields[k] = { key: k, type: 'string', label: k, default: v };
          } else if (Array.isArray(v)) {
            fields[k] = { key: k, type: 'json', label: k, default: v };
          }
        }
        return { fields };
      })() : undefined;

      const saved = await db.upsertStrategyDefinition({
        userId: ctx.user.id,
        key: result.key!,
        name: result.name!,
        description: input.filename ? `上傳檔案：${input.filename}` : undefined,
        sourceCode: input.code,
        defaultConfig: result.defaultConfig,
        schemaConfig: autoSchemaConfig,
        sourceType: input.sourceType,
        isBuiltIn: false,
        isActive: true,
        filePath: `server/strategies/custom/strategy_${Date.now()}_${result.className}.ts`,
      });

      return {
        success: true,
        message: result.message,
        key: result.key,
        name: result.name,
        version: saved.version,
      };
    }),

  /** 刪除自訂策略（內建受保護） */
  delete: protectedProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (isBuiltInKey(input.key)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "內建策略受保護，禁止刪除",
        });
      }
      // 確認沒有策略實例正在使用
      const inUse = await db.listStrategies(ctx.user.id);
      if (inUse.some((s) => s.strategyKey === input.key)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "有策略實例正在使用此策略引擎，請先解除綁定",
        });
      }
      await db.deleteStrategyDefinition(ctx.user.id, input.key);
      unregisterStrategy(input.key);
      return { success: true, message: "策略已刪除" };
    }),

  /** 取得自訂策略原始代碼（編輯用） */
  getSource: protectedProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => {
      if (isBuiltInKey(input.key)) {
        return { code: null, message: "內建策略不提供原始碼編輯" };
      }
      const def = await db.getStrategyDefinitionByKey(input.key);
      if (!def || def.userId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "找不到該策略" });
      }
      return { code: def.sourceCode, message: "ok" };
    }),
});

/* ==================== 策略註冊中心路由（V4.2） ==================== */

const registryRouter = router({
  /** 獲取所有策略定義（供所有模塊使用：回測中心、策略管理、參數快照庫） */
  listDefinitions: publicProcedure
    .input(z.object({ includeInactive: z.boolean().optional() }).optional())
    .query(async ({ ctx }) => {
      const userId = ctx.user?.id;
      return registryManager.getStrategyDefinitions(userId);
    }),

  /** 獲取單個策略定義 */
  getDefinition: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      const definition = await registryManager.getStrategyDefinition(input.key);
      if (!definition) {
        throw new TRPCError({ code: "NOT_FOUND", message: `策略 ${input.key} 不存在` });
      }
      return definition;
    }),

  /** 獲取策略參數結構（前端動態渲染用） */
  getSchema: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      return registryManager.getStrategySchema(input.key);
    }),

  /** 獲取策略預設參數（回測中心、策略管理自動填入） */
  getDefaults: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      return registryManager.getStrategyDefaults(input.key);
    }),

  /** 獲取策略實例列表（含關聯策略名稱） */
  listInstances: protectedProcedure.query(async ({ ctx }) => {
    return registryManager.getInstances(ctx.user.id);
  }),

  /** 套用參數快照到策略實例（驗證定義匹配） */
  applySnapshot: protectedProcedure
    .input(z.object({
      snapshotId: z.number(),
      targetInstanceId: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      return registryManager.applySnapshotToInstance(
        input.snapshotId,
        input.targetInstanceId,
        ctx.user.id,
      );
    }),

  /** 清除快取 */
  clearCache: publicProcedure.mutation(async () => {
    registryManager.clearCache();
    return { success: true };
  }),

  /** 策略名稱統一修改（貫通全系統：註冊中心 + DB 定義 + 記憶體 strategyMap） */
  renameStrategy: protectedProcedure
    .input(z.object({
      key: z.string().min(1),
      newName: z.string().min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const { key, newName } = input;

      // 1. 更新記憶體中的策略名稱（即時生效）
      const memStrategy = getStrategy(key);
      if (memStrategy) {
        (memStrategy as any).name = newName;
      }

      // 2. 更新 DB 中的策略定義名稱
      const dbDef = await db.getStrategyDefinitionByKey(key);
      if (dbDef) {
        const dbConn = await db.getDb();
        if (dbConn) {
          const { strategyDefinitions } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          await dbConn.update(strategyDefinitions)
            .set({ name: newName })
            .where(eq(strategyDefinitions.id, dbDef.id));
        }
      }

      // 3. 清除快取，下次查詢將返回新名稱
      registryManager.clearCache();

      return { success: true, key, newName };
    }),
});

/* ==================== 根路由 ==================== */

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  apiKeys: apiKeysRouter,
  strategies: strategiesRouter,
  signals: signalsRouter,
  tradeJournal: tradeJournalRouter,
  dashboard: dashboardRouter,
  performance: performanceRouter,
  studio: studioRouter,
  exchange: exchangeRouter,
  backtest: backtestRouter,
  autoTrade: autoTradeRouter,
  rainbowTrendLadderAi: rainbowTrendLadderAiRouter,
  registry: registryRouter,
});

export type AppRouter = typeof appRouter;
