/**
 * 策略工作室服務（模塊二）
 * - 註冊中心：記憶體 Map，內建策略受保護（禁止覆蓋/刪除）
 * - 編譯器：esbuild 將用戶 TypeScript 代碼編譯為 CJS 後動態載入
 * - 持久化：自訂策略以 DB sourceCode 為真相來源（serverless 冷啟動時重建）
 * - 檔案備存：server/strategies/custom/strategy_{timestamp}_{className}.ts
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { BaseStrategy, type StrategyCapabilities } from "../strategies/base";
import { Strategy20415 } from "../strategies/builtin/strategy20415";
import { StrategyRainbowTrendLadder } from "../strategies/builtin/strategyRainbowTrendLadder";
import { StrategyKama3kBreakoutV25 } from "../strategies/v25/strategy_kama_3k_breakout_v25";
import { StrategyKama3kV35 } from "../strategies/v35/strategy_kama_3k_v35";
import { StrategyKama3kV50 } from "../strategies/v50/strategy_kama_3k_v50";
import { StrategyKama3kV61 } from "../strategies/v61/strategy_kama_3k_v61";
import { StrategyKama3kV70 } from "../strategies/v70/strategy_kama_3k_v70";
import * as db from "../db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 自訂策略檔案儲存目錄（開發環境備存；serverless 以 DB 為準） */
const CUSTOM_DIR = path.resolve(__dirname, "../strategies/custom");

/** 內建策略 key 清單，受保護 */
export const BUILT_IN_KEYS = [
  "strategy_20415",
  "RAINBOW_TREND_LADDER_V1",
  "KAMA_3K_BREAKOUT_V25",
  "20415_KAMA_MARTIN_V35",
  "KAMA_3K_ULTIMATE_V50",
  "KAMA_3K_HF_V61",
  "KAMA_3K_TORNADO_V70",
] as const;

/**
 * 既有內建策略受逐位元不可變測試保護，能力在可信註冊中心顯式宣告，
 * 不向策略交易程式插入任何 UI／稽核屬性。
 */
const BUILT_IN_CAPABILITIES: Readonly<Record<
  (typeof BUILT_IN_KEYS)[number],
  Readonly<StrategyCapabilities>
>> = Object.freeze({
  strategy_20415: Object.freeze({ martingaleLayers: true }),
  RAINBOW_TREND_LADDER_V1: Object.freeze({ martingaleLayers: true }),
  KAMA_3K_BREAKOUT_V25: Object.freeze({ martingaleLayers: true }),
  "20415_KAMA_MARTIN_V35": Object.freeze({ martingaleLayers: true }),
  KAMA_3K_ULTIMATE_V50: Object.freeze({ martingaleLayers: true }),
  KAMA_3K_HF_V61: Object.freeze({ martingaleLayers: true }),
  KAMA_3K_TORNADO_V70: Object.freeze({ martingaleLayers: true }),
});
const NO_STRATEGY_CAPABILITIES = Object.freeze({ martingaleLayers: false });

/* ==================== 註冊中心 ==================== */

const strategyMap = new Map<string, BaseStrategy>();

export interface StrategyMeta {
  key: string;
  name: string;
  description?: string;
  defaultConfig: Record<string, unknown>;
  capabilities: { martingaleLayers: boolean };
  isBuiltIn: boolean;
  sourceType: "system" | "paste" | "upload";
}

export function getStrategy(key: string): BaseStrategy | undefined {
  return strategyMap.get(key);
}

export function getStrategyCapabilities(key: string): Readonly<StrategyCapabilities> {
  const strategy = strategyMap.get(key);
  if (!strategy) return NO_STRATEGY_CAPABILITIES;
  if (isBuiltInKey(key)) {
    return BUILT_IN_CAPABILITIES[key as (typeof BUILT_IN_KEYS)[number]]
      ?? NO_STRATEGY_CAPABILITIES;
  }
  return Object.freeze({ martingaleLayers: strategy.capabilities.martingaleLayers === true });
}

export function listRegisteredStrategies(): StrategyMeta[] {
  return Array.from(strategyMap.values()).map((s) => ({
    key: s.key,
    name: s.name,
    defaultConfig: s.defaultConfig,
    capabilities: getStrategyCapabilities(s.key),
    isBuiltIn: s.isBuiltIn,
    sourceType: s.isBuiltIn ? "system" : "paste",
  }));
}

export function isBuiltInKey(key: string): boolean {
  return (BUILT_IN_KEYS as readonly string[]).includes(key);
}

function register(instance: BaseStrategy, options?: { allowOverwrite?: boolean }) {
  const existing = strategyMap.get(instance.key);
  if (existing?.isBuiltIn && !instance.isBuiltIn) {
    throw new Error(`策略 key「${instance.key}」為內建策略，禁止覆蓋`);
  }
  if (existing && !options?.allowOverwrite && !existing.isBuiltIn) {
    // 自訂策略允許同 key 更新（版本遞增），此處僅記錄
  }
  strategyMap.set(instance.key, instance);
}

/* ==================== 編譯器（esbuild） ==================== */

export interface CompileResult {
  success: boolean;
  message: string;
  key?: string;
  name?: string;
  className?: string;
  defaultConfig?: Record<string, unknown>;
  instance?: BaseStrategy;
}

/** 基本安全檢查：阻擋明顯危險的 API（縱深防禦第一層） */
const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /child_process/g, label: "child_process" },
  { pattern: /\bprocess\.exit\b/g, label: "process.exit" },
  { pattern: /\bprocess\.env\b/g, label: "process.env" },
  { pattern: /require\s*\(\s*['"]fs['"]\s*\)/g, label: "fs 模組" },
  { pattern: /from\s+['"]fs['"]/g, label: "fs 模組" },
  { pattern: /from\s+['"]net['"]/g, label: "net 模組" },
  { pattern: /from\s+['"]https?['"]/g, label: "http/https 模組" },
  { pattern: /require\s*\(\s*['"](net|https?|dns|os|tls|dgram)['"]\s*\)/g, label: "網路/系統模組" },
  { pattern: /from\s+['"](dns|os|tls|dgram)['"]/g, label: "系統模組" },
  { pattern: /\bfetch\s*\(/g, label: "fetch 網路請求" },
  { pattern: /\bXMLHttpRequest\b/g, label: "XMLHttpRequest" },
  { pattern: /new\s+WebSocket\s*\(/g, label: "WebSocket" },
  { pattern: /\beval\s*\(/g, label: "eval" },
  { pattern: /new\s+Function\s*\(/g, label: "new Function" },
];

export function validateStrategyCode(code: string): { ok: boolean; message: string } {
  if (!code || code.trim().length < 50) {
    return { ok: false, message: "代碼內容過短，請貼上完整的策略類別代碼" };
  }
  if (code.length > 200_000) {
    return { ok: false, message: "代碼超過 200KB 上限" };
  }
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(code)) {
      return { ok: false, message: `代碼包含禁止使用的 API：${label}（策略代碼僅能進行純計算）` };
    }
  }
  if (!/generateActions\s*\(/.test(code)) {
    return { ok: false, message: "代碼缺少 generateActions 方法，請繼承 BaseStrategy 並實作" };
  }
  return { ok: true, message: "ok" };
}

/** 將用戶代碼中的 base 模組 import 重寫為絕對路徑 */
function rewriteBaseImport(code: string): string {
  const basePath = path.resolve(__dirname, "../strategies/base").replace(/\\/g, "/");
  return code
    .replace(/from\s+['"][^'"]*\/base(\.js|\.ts)?['"]/g, `from "${basePath}"`)
    .replace(/from\s+['"]\.\.\/base(\.js|\.ts)?['"]/g, `from "${basePath}"`)
    .replace(/from\s+['"]base['"]/g, `from "${basePath}"`);
}

/**
 * 編譯並載入策略代碼
 * 流程：安全檢查 → esbuild 編譯（bundle base 模組）→ 動態 import → 尋找 BaseStrategy 子類 → 驗證 → 註冊
 */
export async function compileAndLoadStrategy(
  code: string,
  sourceType: "paste" | "upload",
): Promise<CompileResult> {
  const check = validateStrategyCode(code);
  if (!check.ok) return { success: false, message: check.message };

  const timestamp = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-compile-"));
  const tsPath = path.join(tmpDir, `strategy_${timestamp}.ts`);
  const jsPath = path.join(tmpDir, `strategy_${timestamp}.mjs`);

  try {
    fs.writeFileSync(tsPath, rewriteBaseImport(code), "utf-8");

    // esbuild 編譯：bundle 讓 base 模組內聯，platform node、esm 格式
    const esbuildBin = path.resolve(process.cwd(), "node_modules/.bin/esbuild");
    const result = spawnSync(
      fs.existsSync(esbuildBin) ? esbuildBin : "esbuild",
      [
        tsPath,
        "--bundle",
        "--platform=node",
        "--target=node18",
        "--format=esm",
        `--outfile=${jsPath}`,
      ],
      { encoding: "utf-8", timeout: 15000 },
    );

    if (result.status !== 0) {
      const errMsg = (result.stderr || result.stdout || "未知編譯錯誤")
        .split("\n")
        .slice(0, 8)
        .join("\n");
      return { success: false, message: `TypeScript 編譯失敗：\n${errMsg}` };
    }

    // 動態載入編譯產物
    const mod = await import(pathToFileURL(jsPath).href + `?v=${timestamp}`);

    // 尋找具有 generateActions 的匯出類別
    let StrategyClass: (new () => BaseStrategy) | null = null;
    for (const exportName of Object.keys(mod)) {
      const candidate = mod[exportName];
      if (
        typeof candidate === "function" &&
        candidate.prototype &&
        typeof candidate.prototype.generateActions === "function"
      ) {
        StrategyClass = candidate;
        break;
      }
    }

    if (!StrategyClass) {
      return {
        success: false,
        message: "找不到策略類別：請確保 export 一個繼承 BaseStrategy 且實作 generateActions 的類別",
      };
    }

    const instance = new StrategyClass();

    // 驗證必要屬性
    if (!instance.key || typeof instance.key !== "string") {
      return { success: false, message: "策略缺少 key 屬性（string）" };
    }
    if (!/^[a-zA-Z0-9_-]{3,100}$/.test(instance.key)) {
      return { success: false, message: "策略 key 格式無效（僅允許英數、底線、連字號，3-100 字元）" };
    }
    if (!instance.name || typeof instance.name !== "string") {
      return { success: false, message: "策略缺少 name 屬性（string）" };
    }
    if (!instance.defaultConfig || typeof instance.defaultConfig !== "object") {
      return { success: false, message: "策略缺少 defaultConfig 屬性（object）" };
    }

    // 內建策略保護：禁止用戶代碼覆蓋內建 key
    if (isBuiltInKey(instance.key)) {
      return {
        success: false,
        message: `策略 key「${instance.key}」為內建策略，禁止覆蓋。請修改代碼中的 key 屬性。`,
      };
    }

    // 註冊至記憶體
    register(instance);

    // 檔案備存（開發環境；失敗不影響註冊，DB 為真相來源）
    try {
      if (!fs.existsSync(CUSTOM_DIR)) fs.mkdirSync(CUSTOM_DIR, { recursive: true });
      const className = StrategyClass.name || "Strategy";
      const filePath = path.join(CUSTOM_DIR, `strategy_${timestamp}_${className}.ts`);
      fs.writeFileSync(filePath, code, "utf-8");
    } catch {
      // serverless 環境檔案系統可能唯讀，忽略
    }

    return {
      success: true,
      message: `✅ 策略註冊成功：${instance.name}（key: ${instance.key}）`,
      key: instance.key,
      name: instance.name,
      className: StrategyClass.name,
      defaultConfig: instance.defaultConfig,
      instance,
    };
  } catch (e: any) {
    return { success: false, message: `策略載入失敗：${e?.message || "未知錯誤"}` };
  } finally {
    // 清理暫存
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ==================== 初始化與重載 ==================== */

let initialized = false;

/**
 * 初始化策略工作室：註冊內建策略 + 從 DB 重載自訂策略
 * 冷啟動（serverless）時呼叫，DB sourceCode 為真相來源
 */
export async function initStrategyStudio(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 1. 註冊內建策略
  register(new Strategy20415());
  register(new StrategyRainbowTrendLadder());
  register(new StrategyKama3kBreakoutV25());
  register(new StrategyKama3kV35());
  register(new StrategyKama3kV50());
  register(new StrategyKama3kV61());
  register(new StrategyKama3kV70());
  console.log("[StrategyStudio] 內建策略已註冊: strategy_20415, RAINBOW_TREND_LADDER_V1, KAMA_3K_BREAKOUT_V25, 20415_KAMA_MARTIN_V35, KAMA_3K_ULTIMATE_V50, KAMA_3K_HF_V61, KAMA_3K_TORNADO_V70");

  // 2. 從 DB 重載所有啟用中的自訂策略
  try {
    const defs = await db.listAllActiveStrategyDefinitions();
    for (const def of defs) {
      if (def.isBuiltIn || !def.sourceCode) continue;
      const result = await compileAndLoadStrategy(
        def.sourceCode,
        def.sourceType === "upload" ? "upload" : "paste",
      );
      if (result.success) {
        console.log(`[StrategyStudio] 自訂策略已重載: ${def.key}`);
      } else {
        console.warn(`[StrategyStudio] 自訂策略重載失敗 ${def.key}: ${result.message}`);
      }
    }
  } catch (e: any) {
    console.warn("[StrategyStudio] 自訂策略重載跳過:", e?.message);
  }
}

/** 從註冊中心移除自訂策略（內建策略禁止移除） */
export function unregisterStrategy(key: string): void {
  if (isBuiltInKey(key)) {
    throw new Error(`策略「${key}」為內建策略，禁止刪除`);
  }
  strategyMap.delete(key);
}
