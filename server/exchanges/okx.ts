import crypto from "crypto";
import type {
  Balance,
  ExchangeAdapter,
  OrderParams,
  OrderResult,
  Position,
} from "./types";

/**
 * OKX V5 REST API 轉接器
 * 文件：https://www.okx.com/docs-v5/en/
 * 簽名方式：Base64(HMAC-SHA256(timestamp + method + requestPath + body))
 */
/** 任務 1.1：全域 API 請求逾時（10 秒，模擬盤回應較慢需要更長時間） */
const REQUEST_TIMEOUT_MS = 10000;

/** placeOrder 專用：50001 暫時性錯誤的最大重試次數（每個端點） */
const PLACE_ORDER_MAX_RETRIES = 3;
/** 可重試的 OKX 錯誤碼（暫時性服務不可用） */
const RETRYABLE_ERROR_CODES = new Set(["50001", "50004", "50011", "50013"]);
/** OKX API 端點列表（主端點 + 備用端點），持續 50001 時自動切換 */
const OKX_ENDPOINTS = ["https://www.okx.com", "https://aws.okx.com"];
/** 追蹤當前最佳端點索引（全域共享，成功後記住） */
let preferredEndpointIndex = 0;

/**
 * 熔斷器：防止 50001 錯誤時無限重試造成 API 風暴
 * key = instId，value = { failCount, cooldownUntil }
 */
interface CircuitState {
  failCount: number;
  cooldownUntil: number; // Unix ms
}
type OKXPositionMode = "long_short_mode" | "net_mode";

const circuitBreakers = new Map<string, CircuitState>();
const CIRCUIT_MAX_FAILS = 3;
const CIRCUIT_COOLDOWN_MS = 2 * 60 * 1000; // 2 分鐘冷卻（有端點切換後可縮短）

/** 檢查熔斷器是否開啟（冷卻中） */
function isCircuitOpen(symbol: string): boolean {
  const state = circuitBreakers.get(symbol);
  if (!state) return false;
  if (Date.now() < state.cooldownUntil) return true;
  // 冷卻期已過，重置
  circuitBreakers.delete(symbol);
  return false;
}

/** 記錄 50001 失敗 */
function recordCircuitFail(symbol: string): void {
  const state = circuitBreakers.get(symbol) || { failCount: 0, cooldownUntil: 0 };
  state.failCount++;
  if (state.failCount >= CIRCUIT_MAX_FAILS) {
    state.cooldownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.warn(`[熔斷器] ${symbol} 連續 ${state.failCount} 次 50001 錯誤，進入 ${CIRCUIT_COOLDOWN_MS / 1000} 秒冷卻期`);
  }
  circuitBreakers.set(symbol, state);
}

/** 重置熔斷器（成功後） */
function resetCircuit(symbol: string): void {
  circuitBreakers.delete(symbol);
}

/** 指數退避延遲計算（含隨機 jitter） */
function computeBackoff(attempt: number): number {
  const baseMs = 1000; // 1s
  const maxMs = 8000;  // 8s
  const cap = Math.min(baseMs * 2 ** attempt, maxMs);
  return cap / 2 + Math.random() * (cap / 2); // equal-jitter
}

/**
 * OKX 合約規格快取（全域共享，10 分鐘 TTL）
 * key = instId, value = { ctVal, lotSz, minSz }
 */
interface OKXContractSpec {
  ctVal: number;  // 每張合約的 base 幣數量
  lotSz: number;  // 最小步長（張）
  minSz: number;  // 最小下單量（張）
}
/**
 * ★ 核心修復：合約規格快取區分實盤/模擬盤
 * 實盤和模擬盤支持的交易對不同，必須分開快取
 */
const contractSpecCaches = new Map<string, { specs: Map<string, OKXContractSpec>; fetchedAt: number }>();
const CONTRACT_SPEC_TTL = 10 * 60 * 1000;

async function getOKXContractSpecs(testnet: boolean = false): Promise<Map<string, OKXContractSpec>> {
  const cacheKey = testnet ? 'demo' : 'live';
  const cached = contractSpecCaches.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CONTRACT_SPEC_TTL) {
    return cached.specs;
  }
  const specs = new Map<string, OKXContractSpec>();
  // 嘗試所有端點，第一個成功即返回
  let lastErr: any = null;
  for (const endpoint of OKX_ENDPOINTS) {
    try {
      const headers: Record<string, string> = {};
      // ★ 模擬盤需要帶 x-simulated-trading header
      if (testnet) {
        headers['x-simulated-trading'] = '1';
      }
      const res = await fetch(`${endpoint}/api/v5/public/instruments?instType=SWAP`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const item of data?.data ?? []) {
        if (item.state !== "live") continue;
        const ctVal = parseFloat(item.ctVal);
        const lotSz = parseFloat(item.lotSz);
        const minSz = parseFloat(item.minSz);
        if (ctVal > 0 && lotSz > 0 && minSz > 0) {
          specs.set(item.instId, { ctVal, lotSz, minSz });
        }
      }
      contractSpecCaches.set(cacheKey, { specs, fetchedAt: Date.now() });
      const envLabel = testnet ? '模擬盤' : '實盤';
      console.log(`[OKX] ✓ 獲取 ${specs.size} 個${envLabel}合約規格 (${endpoint})`);
      break; // 成功，不再嘗試其他端點
    } catch (err) {
      lastErr = err;
      console.warn(`[OKX] 獲取合約規格失敗 (${endpoint}, ${testnet ? 'demo' : 'live'}):`, (err as Error)?.message);
      continue; // 嘗試下一個端點
    }
  }
  if (specs.size === 0 && lastErr) {
    console.error(`[OKX] 所有端點獲取合約規格失敗 (${testnet ? 'demo' : 'live'}):`, lastErr);
    if (cached) return cached.specs;
  }
  return specs;
}

/**
 * 將 base 幣數量轉換為 OKX 合約張數，並按 lotSz 步長向下取整
 * 返回 { contracts, rejected, reason }
 */
async function convertToContracts(
  instId: string,
  sizeInBase: number,
  testnet: boolean = false,
): Promise<{ contracts: number; rejected: boolean; reason: string }> {
  const specs = await getOKXContractSpecs(testnet);
  const spec = specs.get(instId);
  if (!spec) {
    // 規格缺失時回退：嘗試直接用 sizeInBase 作為張數（可能失敗，但不阻擋）
    console.warn(`[OKX] 找不到 ${instId} 的合約規格，嘗試直接使用原始數量`);
    return { contracts: sizeInBase, rejected: false, reason: "" };
  }

  // BTC 數量 → 張數
  const rawContracts = sizeInBase / spec.ctVal;
  // 按 lotSz 步長向下取整
  const contracts = Math.floor(rawContracts / spec.lotSz + 1e-9) * spec.lotSz;
  // 保留合理精度
  const finalContracts = parseFloat(contracts.toFixed(8));

  if (finalContracts < spec.minSz) {
    return {
      contracts: finalContracts,
      rejected: true,
      reason: `轉換後張數 ${finalContracts} 低於最小下單量 ${spec.minSz}（原始數量 ${sizeInBase} ${instId.split("-")[0]}，ctVal=${spec.ctVal}）`,
    };
  }

  return {
    contracts: finalContracts,
    rejected: false,
    reason: rawContracts !== finalContracts
      ? `${sizeInBase} ${instId.split("-")[0]} → ${finalContracts} 張（ctVal=${spec.ctVal}, lotSz=${spec.lotSz}）`
      : "",
  };
}

export class OKXAdapter implements ExchangeAdapter {
  readonly exchange = "okx" as const;
  private baseUrl = "https://www.okx.com";
  private isTestnet: boolean;

  constructor(
    private apiKey: string,
    private apiSecret: string,
    private passphrase: string,
    isTestnet = false,
  ) {
    this.isTestnet = isTestnet;
    // 使用上次成功的端點
    this.baseUrl = OKX_ENDPOINTS[preferredEndpointIndex] || OKX_ENDPOINTS[0];
  }

  /** 切換到下一個備用端點，返回新端點 URL */
  private switchEndpoint(): string {
    const nextIdx = (OKX_ENDPOINTS.indexOf(this.baseUrl) + 1) % OKX_ENDPOINTS.length;
    this.baseUrl = OKX_ENDPOINTS[nextIdx];
    console.log(`[OKX] ⚔️ 切換到備用端點: ${this.baseUrl}`);
    return this.baseUrl;
  }

  /** 標記當前端點為成功（全域記住） */
  private markEndpointSuccess(): void {
    preferredEndpointIndex = OKX_ENDPOINTS.indexOf(this.baseUrl);
  }

  private sign(timestamp: string, method: string, path: string, body: string): string {
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(timestamp + method + path + body)
      .digest("base64");
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    const timestamp = new Date().toISOString();
    let requestPath = path;
    let body = "";

    if (method === "GET") {
      const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      if (qs) requestPath += `?${qs}`;
    } else {
      body = JSON.stringify(params);
    }

    const signature = this.sign(timestamp, method, requestPath, body);
    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json",
    };
    if (this.isTestnet) {
      headers["x-simulated-trading"] = "1";
    }

    const res = await fetch(`${this.baseUrl}${requestPath}`, {
      method,
      headers,
      body: body || undefined,
      // 任務 1.1：強制 5 秒逾時，逾時主動拋出 Timeout Error
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((e: any) => {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`連線逾時（${REQUEST_TIMEOUT_MS / 1000} 秒），請檢查網路或防火牆設定`);
      }
      throw new Error(`無法連線至 OKX 伺服器：${e?.message || "未知錯誤"}`);
    });
    try {
      return await res.json();
    } catch (e: any) {
      throw new Error(`OKX 回應格式異常：${e?.message || "JSON 解析失敗"}`);
    }
  }

  /** 任務 1.3：OKX 錯誤碼解析，回傳具體原因與解決方法 */
  static parseErrorCode(code: string, msg: string, serverIp?: string): string {
    switch (code) {
      case "50110":
        return `IP 不在白名單內，請將伺服器 IP${serverIp ? ` ${serverIp}` : ""} 加入 OKX API 白名單`;
      case "50111":
        return "API Key 無效，請檢查金鑰是否正確（注意：模擬盤與實盤金鑰不互通）";
      case "50113":
        return "簽名驗證失敗，請檢查 API Secret 是否正確";
      case "50105":
        return "Passphrase 錯誤，請檢查 API Passphrase 是否正確";
      case "50114":
        return "API 權限不足，請確認已勾選「讀取」與「交易」權限";
      case "51010":
        return "OKX 拒絕訂單（51010 帳戶模式不匹配）：系統已依當前 posMode 自動組裝訂單；請確認此 API Key 對應正確的實盤／模擬子帳號，並重新執行帳戶模式診斷";
      case "51008":
        return "訂單金額不足：請確認帳戶有足夠 USDT 保證金";
      case "50001":
        return "OKX matching engine 維護中（已自動重試多端點，仍失敗），通常 5-30 分鐘內恢復，下次輪詢將自動重試";
      default:
        return `OKX 錯誤 ${code}: ${msg}`;
    }
  }

  /** OKX 永續合約符號格式：BTC-USDT-SWAP */
  normalizeSymbol(symbol: string): string {
    const clean = symbol.replace(/[-/]/g, "").toUpperCase().replace(".P", "");
    if (symbol.toUpperCase().includes("SWAP")) {
      return symbol.toUpperCase();
    }
    // BTCUSDT -> BTC-USDT-SWAP
    const quote = clean.endsWith("USDT") ? "USDT" : clean.endsWith("USDC") ? "USDC" : "USDT";
    const base = clean.slice(0, clean.length - quote.length);
    return `${base}-${quote}-SWAP`;
  }

  async testConnection(serverIp?: string): Promise<{ success: boolean; message: string; balance?: number }> {
    try {
      const data = await this.request("GET", "/api/v5/account/balance", {
        ccy: "USDT",
      });
      if (data.code === "0") {
        const detail = data.data?.[0]?.details?.find((d: any) => d.ccy === "USDT");
        const balance = parseFloat(detail?.cashBal || data.data?.[0]?.totalEq || "0");
        return {
          success: true,
          message: `連線成功，餘額：${balance.toFixed(2)} USDT`,
          balance,
        };
      }
      return {
        success: false,
        message: OKXAdapter.parseErrorCode(data.code, data.msg, serverIp),
      };
    } catch (e: any) {
      return { success: false, message: `連線失敗：${e.message}` };
    }
  }

  async setLeverage(instId: string, leverage: number, posSide?: "long" | "short"): Promise<void> {
    try {
      const body: Record<string, string> = {
        instId,
        lever: String(leverage),
        mgnMode: "cross",
      };
      // 雙向持倉模式下必須指定 posSide，否則會同時修改兩個方向的槓桿
      if (posSide) {
        body.posSide = posSide;
      }
      await this.request("POST", "/api/v5/account/set-leverage", body);
    } catch {
      // 忽略槓桿設定失敗（可能已為相同槓桿）
    }
  }

  private async getPositionMode(): Promise<OKXPositionMode> {
    const config = await this.getAccountConfig();
    if (config.posMode !== "long_short_mode" && config.posMode !== "net_mode") {
      throw new Error(`無法確認 OKX 持倉模式（posMode=${config.posMode || "empty"}），為避免 51010 已取消下單`);
    }
    return config.posMode;
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const TAG = `[OKX][placeOrder]`;
    try {
      const instId = this.normalizeSymbol(params.symbol);
      // 以這組 API Key 的真實帳戶設定為準；模擬子帳號與實盤可能使用不同 posMode。
      // 查詢失敗時採 fail-closed，絕不猜測模式後送出可能不相容的訂單。
      const posMode = await this.getPositionMode();
      const inferredPosSide: "long" | "short" = params.reduceOnly
        ? (params.side === "buy" ? "short" : "long")
        : (params.side === "buy" ? "long" : "short");
      const dualModePosSide: "long" | "short" =
        params.posSide === "long" || params.posSide === "short"
          ? params.posSide
          : inferredPosSide;

      if (params.leverage && !params.reduceOnly) {
        // 雙向持倉分方向設定槓桿；單向模式不得傳 long／short posSide。
        await this.setLeverage(
          instId,
          params.leverage,
          posMode === "long_short_mode" ? dualModePosSide : undefined,
        );
      }

      // ★ 核心修復：將 base 幣數量轉換為 OKX 合約張數，並按 lotSz 步長取整
      // ★ 傳入 testnet 參數，確保使用對應環境的合約規格
      const conversion = await convertToContracts(instId, params.size, this.isTestnet);
      if (conversion.rejected) {
        return {
          success: false,
          rawResponse: JSON.stringify({ info: "pre-flight rejected" }),
          errorMessage: `訂單數量不足：${conversion.reason}`,
        };
      }
      if (conversion.reason) {
        console.log(`${TAG} 數量轉換：${conversion.reason}`);
      }

      const body: Record<string, unknown> = {
        instId,
        tdMode: "cross",
        side: params.side,
        ordType: params.orderType,
        sz: String(conversion.contracts),
      };
      // 雙向持倉模式必須送 long／short；單向持倉模式省略 posSide。
      if (posMode === "long_short_mode") {
        body.posSide = dualModePosSide;
      }
      console.log(
        `${TAG} 帳戶模式=${posMode}，訂單 posSide=${String(body.posSide ?? "(omitted/net)")}，` +
        `環境=${this.isTestnet ? "demo" : "live"}`,
      );
      if (params.orderType === "limit" && params.price) {
        body.px = String(params.price);
      }
      if (params.reduceOnly) {
        body.reduceOnly = true;
      }

      // ★ 核心修復：對 50001 等暫時性錯誤加入指數退避重試 + 端點自動切換
      let lastErrCode = "";
      let lastErrMsg = "";
      let lastRawResponse = "{}";
      let endpointsTried = 0;
      const maxEndpoints = OKX_ENDPOINTS.length;

      // 外層迴圈：嘗試每個端點
      while (endpointsTried < maxEndpoints) {
        // 內層迴圈：在當前端點上重試
        for (let attempt = 0; attempt <= PLACE_ORDER_MAX_RETRIES; attempt++) {
          if (attempt > 0) {
            const backoffMs = computeBackoff(attempt - 1);
            console.log(`${TAG} 重試 #${attempt}/${PLACE_ORDER_MAX_RETRIES}（端點: ${this.baseUrl}），等待 ${Math.round(backoffMs)}ms...`);
            await new Promise(r => setTimeout(r, backoffMs));
          }

          let data: any;
          try {
            data = await this.request("POST", "/api/v5/trade/order", body);
          } catch (e: any) {
            // 網路錯誤（逾時、斷線）也可重試
            console.warn(`${TAG} 網路異常 (attempt ${attempt}, endpoint ${this.baseUrl}): ${e.message}`);
            lastErrCode = "NETWORK";
            lastErrMsg = e.message;
            lastRawResponse = "{}";
            if (attempt < PLACE_ORDER_MAX_RETRIES) continue;
            // 當前端點網路全掉，嘗試下一個端點
            break;
          }

          const detail = data.data?.[0];
          if (data.code === "0" && detail?.sCode === "0") {
            // 下單成功！重置熔斷器，記住成功端點
            resetCircuit(instId);
            this.markEndpointSuccess();
            if (attempt > 0 || endpointsTried > 0) {
              console.log(`${TAG} ✅ 成功！（端點=${this.baseUrl}, attempt=${attempt}, endpointsTried=${endpointsTried}）orderId=${detail.ordId}`);
            }

            // 市價單查詢實際成交數據
            let filledPrice: number | undefined;
            let filledSize: number | undefined;
            if (params.orderType === "market") {
              try {
                await new Promise((r) => setTimeout(r, 300));
                const orderInfo = await this.request("GET", "/api/v5/trade/order", {
                  instId,
                  ordId: detail.ordId,
                });
                const orderDetail = orderInfo.data?.[0];
                if (orderDetail) {
                  const avgPx = parseFloat(orderDetail.avgPx || "0");
                  const accFillSz = parseFloat(orderDetail.accFillSz || "0");
                  if (avgPx > 0) filledPrice = avgPx;
                  if (accFillSz > 0) {
                    const specs = await getOKXContractSpecs(this.isTestnet);
                    const specForInst = specs.get(instId);
                    const ctVal = specForInst
                      ? specForInst.ctVal
                      : parseFloat(orderDetail.ctVal || "0.01");
                    filledSize = accFillSz * ctVal;
                    console.log(`${TAG} 成交詳情: ${accFillSz} 張 × ctVal=${ctVal} = ${filledSize} ${instId.split("-")[0]}`);
                  }
                }
              } catch (e) {
                console.log(`${TAG} 查詢訂單詳情失敗，使用理論值: ${(e as Error).message}`);
              }
            }
            return {
              success: true,
              orderId: detail.ordId,
              rawResponse: JSON.stringify(data),
              filledPrice,
              filledSize,
            };
          }

          // 下單失敗，檢查是否可重試
          const errCode = detail?.sCode || data.code;
          const errMsg = detail?.sMsg || data.msg;
          lastErrCode = errCode;
          lastErrMsg = errMsg;
          lastRawResponse = JSON.stringify(data);

          console.warn(`${TAG} 下單失敗 (endpoint=${this.baseUrl}, attempt=${attempt}): code=${errCode} msg=${errMsg}`);

          // 僅對暫時性錯誤重試（如 50001 服務不可用）
          if (RETRYABLE_ERROR_CODES.has(errCode) && attempt < PLACE_ORDER_MAX_RETRIES) {
            recordCircuitFail(instId);
            // 如果熔斷器已觸發，嘗試切換端點而不是直接放棄
            if (isCircuitOpen(instId)) {
              console.warn(`${TAG} 熔斷器觸發 ${instId}，嘗試切換端點...`);
              break; // 跳出內層迴圈，嘗試下一個端點
            }
            continue; // 同端點重試
          }

          // 不可重試的錯誤（如資金不足、權限不足等），立即返回
          return {
            success: false,
            rawResponse: lastRawResponse,
            errorMessage: OKXAdapter.parseErrorCode(errCode, errMsg),
          };
        }

        // 當前端點全部重試失敗，切換到下一個端點
        endpointsTried++;
        if (endpointsTried < maxEndpoints) {
          // 重置熔斷器（新端點不應繼承舊端點的熔斷狀態）
          resetCircuit(instId);
          this.switchEndpoint();
          console.log(`${TAG} 端點 ${endpointsTried}/${maxEndpoints} 失敗，切換到 ${this.baseUrl} 繼續嘗試...`);
        }
      }

      // 所有端點、所有重試用完仍失敗
      const totalAttempts = maxEndpoints * (PLACE_ORDER_MAX_RETRIES + 1);
      return {
        success: false,
        rawResponse: lastRawResponse,
        errorMessage: `OKX 下單失敗（已嘗試 ${maxEndpoints} 個端點、共 ${totalAttempts} 次）：${lastErrCode === "50001" ? "OKX 模擬盤/實盤 matching engine 維護中，請稍後再試" : OKXAdapter.parseErrorCode(lastErrCode, lastErrMsg)}`,
      };
    } catch (e: any) {
      return { success: false, rawResponse: "{}", errorMessage: e.message };
    }
  }

  async getBalance(): Promise<Balance> {
    const data = await this.request("GET", "/api/v5/account/balance", {
      ccy: "USDT",
    });
    if (data.code !== "0") {
      throw new Error(`OKX ${data.code}: ${data.msg}`);
    }
    const account = data.data?.[0];
    const detail = account?.details?.find((d: any) => d.ccy === "USDT");
    return {
      asset: "USDT",
      free: parseFloat(detail?.availBal || "0"),
      total: parseFloat(account?.totalEq || "0"),
      unrealizedPnl: parseFloat(detail?.upl || account?.upl || "0"),
      usedMargin: parseFloat(detail?.imr || "0"),
    };
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const params: Record<string, unknown> = { instType: "SWAP" };
    if (symbol) params.instId = this.normalizeSymbol(symbol);
    const data = await this.request("GET", "/api/v5/account/positions", params);
    if (data.code !== "0") {
      throw new Error(`OKX ${data.code}: ${data.msg}`);
    }
    // 🔥 修復：優先從合約規格快取獲取正確的 ctVal，避免 OKX 返回空值時用錯誤默認值
    const specs = await getOKXContractSpecs(this.isTestnet);
    return (data.data || [])
      .filter((p: any) => parseFloat(p.pos) !== 0)
      .map((p: any) => {
        const pos = parseFloat(p.pos); // 張數（雙向模式永遠正數，單向模式正=多負=空）
        const instId = p.instId as string;
        const specForInst = specs.get(instId);
        const ctVal = specForInst
          ? specForInst.ctVal
          : parseFloat(p.ctVal || "0.01"); // fallback 到 OKX 返回值或默認
        const sizeInBtc = Math.abs(pos) * ctVal; // 轉換為幣數
        // 判斷持倉方向：
        // - 雙向持倉模式（long_short_mode）：posSide 欄位為 "long" 或 "short"，pos 永遠正數
        // - 單向持倉模式（net_mode）：posSide 欄位為 "net"，pos 正數=多頭、負數=空頭
        let side: "long" | "short";
        if (p.posSide === "long" || p.posSide === "short") {
          // 雙向模式：直接用 OKX 回傳的 posSide
          side = p.posSide;
        } else {
          // 單向模式（posSide="net"）：用 pos 正負判斷
          side = pos > 0 ? "long" : "short";
        }
        return {
          symbol: p.instId,
          side,
          size: sizeInBtc,
          entryPrice: parseFloat(p.avgPx),
          markPrice: parseFloat(p.markPx),
          unrealizedPnl: parseFloat(p.upl),
          leverage: parseFloat(p.lever),
          positionMargin: parseFloat(p.margin || p.imr || "0") || undefined,
          unrealizedPnlRatioPct: p.uplRatio !== undefined && p.uplRatio !== ""
            ? parseFloat(p.uplRatio) * 100
            : undefined,
          updatedAt: parseInt(p.uTime || "0", 10) || undefined,
          liquidationPrice: p.liqPx ? parseFloat(p.liqPx) || undefined : undefined,
          marginRatio: p.mgnRatio ? parseFloat(p.mgnRatio) * 100 : undefined,
        };
      });
  }

  async cancelOrder(symbol: string, orderId: string): Promise<OrderResult> {
    try {
      const data = await this.request("POST", "/api/v5/trade/cancel-order", {
        instId: this.normalizeSymbol(symbol),
        ordId: orderId,
      });
      const detail = data.data?.[0];
      return {
        success: data.code === "0" && detail?.sCode === "0",
        orderId,
        rawResponse: JSON.stringify(data),
        errorMessage:
          data.code !== "0" ? detail?.sMsg || data.msg : undefined,
      };
    } catch (e: any) {
      return { success: false, rawResponse: "{}", errorMessage: e.message };
    }
  }

  /**
   * 平倉方法（平台級別通用，適用於所有策略）
   * 
   * 策略：
   * 1. 先查詢帳戶 posMode（單向/雙向）
   * 2. 查詢真實持倉，獲取精確的張數和方向
   * 3. 使用 placeOrder + reduceOnly 以市價單平倉（更可靠，可指定精確數量）
   * 4. 平倉後驗證持倉是否已清
   * 5. 如果 placeOrder 失敗，fallback 到 close-position API
   */
  async closePosition(symbol: string, posSide?: "long" | "short" | "net"): Promise<OrderResult> {
    const instId = this.normalizeSymbol(symbol);

    // 熔斷器檢查
    if (isCircuitOpen(instId)) {
      const state = circuitBreakers.get(instId)!;
      const remainSec = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
      console.warn(`[OKX closePosition] 熔斷器開啟中，${instId} 剩餘冷卻 ${remainSec} 秒`);
      return { success: false, errorMessage: `熔斷器開啟：${instId} 冷卻中`, rawResponse: "{}" };
    }

    try {

      // 步驟 1：查詢帳戶 posMode
      let posMode = "long_short_mode"; // 預設雙向持倉
      try {
        const config = await this.getAccountConfig();
        posMode = config.posMode;
        console.log(`[OKX closePosition] 帳戶 posMode=${posMode}`);
      } catch (e: any) {
        console.warn(`[OKX closePosition] 查詢 posMode 失敗，使用預設 long_short_mode:`, e?.message);
      }

      // 步驟 2：查詢真實持倉（用原始 API 回應以獲取 posSide 和張數）
      const posData = await this.request("GET", "/api/v5/account/positions", {
        instType: "SWAP",
        instId,
      });
      if (posData.code !== "0") {
        console.error(`[OKX closePosition] 查詢持倉失敗:`, posData);
        // 查詢失敗時 fallback 到 close-position API
        return this.closePositionFallback(instId, posSide, posMode);
      }

      const activePositions = (posData.data || []).filter((p: any) => parseFloat(p.pos) !== 0);
      if (activePositions.length === 0) {
        return { success: true, rawResponse: JSON.stringify({ info: "無持倉可平" }) };
      }

      // 步驟 3：對每個持倉方向執行平倉
      let lastResult: OrderResult = { success: true, rawResponse: "{}" };
      let allSuccess = true;

      for (const rawPos of activePositions) {
        const posQty = Math.abs(parseFloat(rawPos.pos)); // 張數（絕對值）
        const rawPosSide = rawPos.posSide || ""; // OKX 原始 posSide（net/long/short）

        // 判斷持倉方向：
        // - 雙向持倉模式（long_short_mode）：pos 永遠是正數，方向由 posSide 決定
        // - 單向持倉模式（net_mode）：pos 正數=多頭，負數=空頭
        let posDir: "long" | "short";
        if (posMode === "long_short_mode" && (rawPosSide === "long" || rawPosSide === "short")) {
          // 雙向模式：直接用 OKX 回傳的 posSide 作為持倉方向
          posDir = rawPosSide;
        } else {
          // 單向模式：用 pos 正負判斷
          posDir = parseFloat(rawPos.pos) > 0 ? "long" : "short";
        }

        // 平倉方向：平多=sell，平空=buy
        const closeSide = posDir === "long" ? "sell" : "buy";

        // 根據 posMode 決定傳給 placeOrder 的 posSide
        let orderPosSide: "long" | "short" | "net";
        if (posMode === "net_mode") {
          orderPosSide = "net";
        } else {
          // long_short_mode：直接用持倉方向
          orderPosSide = posDir;
        }

        console.log(`[OKX closePosition] 平倉 ${instId} posMode=${posMode} posDir=${posDir} rawPosSide=${rawPosSide} orderPosSide=${orderPosSide} qty=${posQty}張 closeSide=${closeSide}`);

        // 使用 placeOrder + reduceOnly 平倉（更可靠，可指定精確數量）
        const body: Record<string, unknown> = {
          instId,
          tdMode: "cross",
          side: closeSide,
          ordType: "market",
          sz: String(posQty),
          reduceOnly: true,
        };
        // 僅在雙向持倉模式下傳遞 posSide（單向模式不傳或傳 net）
        if (posMode === "net_mode") {
          // 單向模式：不傳 posSide，也不傳 reduceOnly（OKX 單向模式不支援 reduceOnly）
          // 單向模式下，賣出就是平多，買入就是平空（如果有持倉的話）
          delete body.reduceOnly;
        } else {
          body.posSide = orderPosSide;
        }

        const orderData = await this.request("POST", "/api/v5/trade/order", body);
        const detail = orderData.data?.[0];

        if (orderData.code === "0" && detail?.sCode === "0") {
          lastResult = {
            success: true,
            orderId: detail.ordId,
            rawResponse: JSON.stringify(orderData),
          };
          console.log(`[OKX closePosition] 平倉成功 ${instId} ${posDir} orderId=${detail.ordId}`);
          // 查詢成交明細以獲取 filledPrice（修復 PnL 顯示為空）
          if (detail.ordId) {
            const fillDetails = await this.queryOrderFillDetails(instId, detail.ordId);
            if (fillDetails.filledPrice) lastResult.filledPrice = fillDetails.filledPrice;
            if (fillDetails.filledSize) lastResult.filledSize = fillDetails.filledSize;
          }
                } else {
          const errCode = detail?.sCode || orderData.code;
          const errMsg = detail?.sMsg || orderData.msg;
          console.error(`[OKX closePosition] placeOrder 平倉失敗 ${instId} ${posDir}: ${errCode} ${errMsg}`);

          // 50001 特殊處理：記錄熔斷器，不再 fallback（避免放大 API 請求）
          if (errCode === "50001") {
            recordCircuitFail(instId);
            lastResult = {
              success: false,
              rawResponse: JSON.stringify(orderData),
              errorMessage: `OKX 50001: ${errMsg}，等待下一輪重試`,
            };
            return lastResult; // 直接返回，不再 fallback
          }

          // 其他錯誤：Fallback 嘗試 close-position API
          console.log(`[OKX closePosition] 嘗試 fallback close-position API...`);
          const fallbackResult = await this.closePositionFallback(instId, orderPosSide, posMode);
          if (fallbackResult.success) {
            lastResult = fallbackResult;
            resetCircuit(instId);
            console.log(`[OKX closePosition] fallback 成功 ${instId} ${posDir}`);
          } else {
            allSuccess = false;
            lastResult = {
              success: false,
              rawResponse: JSON.stringify(orderData),
              errorMessage: `OKX 平倉失敗 (${errCode}): ${errMsg}. Fallback 也失敗: ${fallbackResult.errorMessage}`,
            };
          }
        }
      }

      // 步驟 4：平倉後驗證
      if (allSuccess) {
        try {
          await new Promise(resolve => setTimeout(resolve, 500)); // 等待 500ms 讓交易所處理
          const verifyData = await this.request("GET", "/api/v5/account/positions", {
            instType: "SWAP",
            instId,
          });
          const remaining = (verifyData.data || []).filter((p: any) => parseFloat(p.pos) !== 0);
          if (remaining.length > 0) {
            const remainInfo = remaining.map((p: any) => `${p.posSide}:${p.pos}張`).join(", ");
            console.warn(`[OKX closePosition] 平倉後仍有殘餘持倉: ${remainInfo}`);
            // 不將此視為失敗（可能是延遲），但記錄警告
            lastResult.rawResponse = JSON.stringify({
              ...JSON.parse(lastResult.rawResponse || "{}"),
              _warning: `平倉後仍有殘餘持倉: ${remainInfo}`,
            });
          } else {
            console.log(`[OKX closePosition] 平倉驗證通過，${instId} 已無持倉`);
          }
        } catch (e: any) {
          console.warn(`[OKX closePosition] 平倉後驗證失敗:`, e?.message);
        }
      }

      return lastResult;
    } catch (e: any) {
      return { success: false, rawResponse: "{}", errorMessage: e.message };
    }
  }

  /**
   * 查詢訂單成交明細（filledPrice / filledSize / pnl）
   * 用於市價平倉後補充成交資訊，解決 PnL 顯示為空的問題
   */
  private async queryOrderFillDetails(instId: string, orderId: string): Promise<{ filledPrice?: number; filledSize?: number; pnl?: number }> {
    try {
      await new Promise(resolve => setTimeout(resolve, 800));
      const orderInfo = await this.request("GET", "/api/v5/trade/order", { instId, ordId: orderId });
      const detail = orderInfo.data?.[0];
      if (!detail) return {};
      // 接受 filled 或 partially_filled 狀態
      if (detail.state !== "filled" && detail.state !== "partially_filled") {
        // 再等 500ms 重試一次（市價單通常很快成交）
        await new Promise(resolve => setTimeout(resolve, 500));
        const retry = await this.request("GET", "/api/v5/trade/order", { instId, ordId: orderId });
        const retryDetail = retry.data?.[0];
        if (!retryDetail || (retryDetail.state !== "filled" && retryDetail.state !== "partially_filled")) return {};
        const avgPx = parseFloat(retryDetail.avgPx || "0");
        const accFillSz = parseFloat(retryDetail.accFillSz || "0");
        const pnl = parseFloat(retryDetail.pnl || "0");
        const specs = await getOKXContractSpecs(this.isTestnet);
        const specForInst = specs.get(instId);
        const ctVal = specForInst ? specForInst.ctVal : parseFloat(retryDetail.ctVal || "0.01");
        const filledSize = accFillSz * ctVal;
        console.log(`[OKX queryOrderFillDetails] 重試成功 orderId=${orderId} avgPx=${avgPx} size=${filledSize} pnl=${pnl}`);
        return { filledPrice: avgPx || undefined, filledSize: filledSize || undefined, pnl: pnl || undefined };
      }
      const avgPx = parseFloat(detail.avgPx || "0");
      const accFillSz = parseFloat(detail.accFillSz || "0");
      const pnl = parseFloat(detail.pnl || "0");
      const specs = await getOKXContractSpecs(this.isTestnet);
      const specForInst = specs.get(instId);
      const ctVal = specForInst ? specForInst.ctVal : parseFloat(detail.ctVal || "0.01");
      const filledSize = accFillSz * ctVal;
      console.log(`[OKX queryOrderFillDetails] orderId=${orderId} avgPx=${avgPx} size=${filledSize} pnl=${pnl}`);
      return { filledPrice: avgPx || undefined, filledSize: filledSize || undefined, pnl: pnl || undefined };
    } catch (e: any) {
      console.warn(`[OKX queryOrderFillDetails] 查詢失敗:`, e?.message);
      return {};
    }
  }

  /**
   * Fallback 平倉：使用 OKX close-position API
   */
  private async closePositionFallback(
    instId: string,
    posSide: "long" | "short" | "net" | undefined,
    posMode: string,
  ): Promise<OrderResult> {
    try {
      const body: Record<string, unknown> = {
        instId,
        mgnMode: "cross",
        autoCxl: true,
      };
      // 根據 posMode 決定 posSide 參數
      if (posMode === "net_mode") {
        body.posSide = "net";
      } else if (posSide && posSide !== "net") {
        body.posSide = posSide;
      }
      console.log(`[OKX closePositionFallback] ${instId} posMode=${posMode} posSide=${body.posSide || "(未傳)"}`);
      const data = await this.request("POST", "/api/v5/trade/close-position", body);
      if (data.code === "0") {
        const result: OrderResult = { success: true, orderId: data.data?.[0]?.ordId, rawResponse: JSON.stringify(data) };
        // 查詢成交明細以獲取 filledPrice
        if (result.orderId) {
          const fillDetails = await this.queryOrderFillDetails(instId, result.orderId);
          if (fillDetails.filledPrice) result.filledPrice = fillDetails.filledPrice;
          if (fillDetails.filledSize) result.filledSize = fillDetails.filledSize;
        }
        return result;
      }
      // 51023 = 無持倉
      if (data.code === "51023" || data.data?.[0]?.sCode === "51023") {
        return { success: true, rawResponse: JSON.stringify({ info: "無持倉可平" }) };
      }
      return {
        success: false,
        rawResponse: JSON.stringify(data),
        errorMessage: `OKX close-position ${data.code}: ${data.msg}`,
      };
    } catch (e: any) {
      return { success: false, rawResponse: "{}", errorMessage: e.message };
    }
  }

  /**
   * 智能平倉：先限價掛單（maker 費率 0.02%），超時未成交則取消改市價兜底
   * 相比純市價平倉（taker 0.05%），節省 60% 手續費
   */
  async closePositionSmart(
    symbol: string,
    posSide?: "long" | "short" | "net",
    timeoutMs: number = 3000,
    priceOffsetPct: number = 0.02,
  ): Promise<OrderResult> {
    const instId = this.normalizeSymbol(symbol);
    const TAG = `[OKX closePositionSmart]`;

    // 熔斷器檢查：連續失敗後進入冷卻期，避免無謂的 API 請求
    if (isCircuitOpen(instId)) {
      const state = circuitBreakers.get(instId)!;
      const remainSec = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
      console.warn(`${TAG} 熔斷器開啟中，${instId} 剩餘冷卻 ${remainSec} 秒，跳過平倉嘗試`);
      return {
        success: false,
        errorMessage: `熔斷器開啟：${instId} 連續 ${CIRCUIT_MAX_FAILS} 次失敗，冷卻 ${remainSec} 秒後重試`,
        rawResponse: "{}",
      };
    }

    try {
      // 步驟 1：查詢帳戶 posMode
      let posMode = "long_short_mode";
      try {
        const config = await this.getAccountConfig();
        posMode = config.posMode;
      } catch (e: any) {
        console.warn(`${TAG} 查詢 posMode 失敗，使用預設:`, e?.message);
      }

      // 步驟 2：查詢真實持倉（獲取張數、方向、markPrice）
      const posData = await this.request("GET", "/api/v5/account/positions", {
        instType: "SWAP",
        instId,
      });
      if (posData.code !== "0") {
        console.warn(`${TAG} 查詢持倉失敗，fallback 市價平倉`);
        return this.closePosition(symbol, posSide);
      }

      const activePositions = (posData.data || []).filter((p: any) => parseFloat(p.pos) !== 0);
      if (activePositions.length === 0) {
        return { success: true, rawResponse: JSON.stringify({ info: "無持倉可平" }) };
      }

      // 對每個持倉方向執行智能平倉
      let lastResult: OrderResult = { success: true, rawResponse: "{}" };

      for (const rawPos of activePositions) {
        const posQty = Math.abs(parseFloat(rawPos.pos)); // 張數
        const markPrice = parseFloat(rawPos.markPx || "0");
        const rawPosSide = rawPos.posSide || "";

        // 判斷持倉方向
        let posDir: "long" | "short";
        if (posMode === "long_short_mode" && (rawPosSide === "long" || rawPosSide === "short")) {
          posDir = rawPosSide;
        } else {
          posDir = parseFloat(rawPos.pos) > 0 ? "long" : "short";
        }

        // 平倉方向：平多=sell，平空=buy
        const closeSide = posDir === "long" ? "sell" : "buy";

        // 計算限價：偏移方向要「有利於成交」
        // 賣出價稍低於 markPrice，買入價稍高於 markPrice
        let limitPrice: number;
        if (closeSide === "sell") {
          limitPrice = markPrice * (1 - priceOffsetPct / 100);
        } else {
          limitPrice = markPrice * (1 + priceOffsetPct / 100);
        }

        // 價格精度處理
        if (markPrice > 10000) {
          limitPrice = Math.round(limitPrice * 10) / 10; // BTC 等大幣種精度 0.1
        } else if (markPrice > 100) {
          limitPrice = Math.round(limitPrice * 100) / 100; // ETH 等精度 0.01
        } else {
          limitPrice = Math.round(limitPrice * 1000) / 1000; // 小幣種精度 0.001
        }

        // 根據 posMode 決定 posSide 參數
        let orderPosSide: "long" | "short" | "net";
        if (posMode === "net_mode") {
          orderPosSide = "net";
        } else {
          orderPosSide = posDir;
        }

        console.log(`${TAG} 掙限價單 ${instId} ${posDir} qty=${posQty}張 limitPrice=${limitPrice} (mark=${markPrice}, offset=${priceOffsetPct}%)`);

        // 步驟 3：掙限價平倉單
        const body: Record<string, unknown> = {
          instId,
          tdMode: "cross",
          side: closeSide,
          ordType: "limit",
          sz: String(posQty),
          px: String(limitPrice),
          reduceOnly: true,
        };
        if (posMode === "net_mode") {
          delete body.reduceOnly;
        } else {
          body.posSide = orderPosSide;
        }

        const orderData = await this.request("POST", "/api/v5/trade/order", body);
        const detail = orderData.data?.[0];

        if (orderData.code !== "0" || detail?.sCode !== "0") {
          const errCode = detail?.sCode || orderData.code;
          const errMsg = detail?.sMsg || orderData.msg;

          // 50001 特殊處理：指數退避重試，不立即 fallback
          if (errCode === "50001") {
            recordCircuitFail(instId);
            if (isCircuitOpen(instId)) {
              console.error(`${TAG} 50001 熔斷器觸發，停止重試 ${instId}`);
              lastResult = { success: false, errorMessage: `熔斷器開啟：${instId} 進入冷卻期`, rawResponse: JSON.stringify(orderData) };
              return lastResult;
            }
            // 指數退避等待後重試（下一輪監控器循環會再嘗試）
            const backoffMs = computeBackoff((circuitBreakers.get(instId)?.failCount || 1) - 1);
            console.warn(`${TAG} 50001 錯誤，等待 ${Math.round(backoffMs)}ms 後由下一輪監控重試（不立即 fallback 避免放大 API 請求）`);
            lastResult = { success: false, errorMessage: `OKX 50001: ${errMsg}，將在下一輪重試`, rawResponse: JSON.stringify(orderData) };
            return lastResult;
          }

          // 其他錯誤：fallback 市價平倉
          console.warn(`${TAG} 限價單下單失敗 (${errCode}: ${errMsg})，fallback 市價平倉`);
          lastResult = await this.closePosition(symbol, posSide);
          continue;
        }

        // 下單成功，重置熔斷器
        resetCircuit(instId);

        const orderId = detail.ordId;
        console.log(`${TAG} 限價單已提交 orderId=${orderId}，等待 ${timeoutMs}ms...`);

        // 步驟 4：等待超時後檢查訂單狀態
        await new Promise(resolve => setTimeout(resolve, timeoutMs));

        // 查詢訂單狀態
        const orderInfo = await this.request("GET", "/api/v5/trade/order", {
          instId,
          ordId: orderId,
        });
        const orderDetail = orderInfo.data?.[0];
        const state = orderDetail?.state; // filled / partially_filled / live / canceled

        if (state === "filled") {
          // 完全成交！節省了 taker 費用
          const avgPx = parseFloat(orderDetail.avgPx || "0");
          const accFillSz = parseFloat(orderDetail.accFillSz || "0");
          const specs = await getOKXContractSpecs(this.isTestnet);
          const specForInst = specs.get(instId);
          const ctVal = specForInst ? specForInst.ctVal : parseFloat(orderDetail.ctVal || "0.01");
          const filledSize = accFillSz * ctVal;
          console.log(`${TAG} ✓ 限價單完全成交！avgPx=${avgPx} size=${filledSize} (節省 taker 費用)`);
          lastResult = {
            success: true,
            orderId,
            rawResponse: JSON.stringify(orderData),
            filledPrice: avgPx || undefined,
            filledSize: filledSize || undefined,
          };
          continue;
        }

        if (state === "partially_filled") {
          // 部分成交，取消剩餘後市價補平
          const filledQty = parseFloat(orderDetail.accFillSz || "0");
          const remainQty = posQty - filledQty;
          console.log(`${TAG} 部分成交 ${filledQty}/${posQty}張，取消剩餘後市價補平 ${remainQty}張`);

          await this.cancelOrder(symbol, orderId);
          await new Promise(resolve => setTimeout(resolve, 300));

          // 市價補平剩餘
          const mktBody: Record<string, unknown> = {
            instId,
            tdMode: "cross",
            side: closeSide,
            ordType: "market",
            sz: String(remainQty),
            reduceOnly: true,
          };
          if (posMode === "net_mode") {
            delete mktBody.reduceOnly;
          } else {
            mktBody.posSide = orderPosSide;
          }
          const mktResult = await this.request("POST", "/api/v5/trade/order", mktBody);
          const mktDetail = mktResult.data?.[0];
          if (mktResult.code === "0" && mktDetail?.sCode === "0") {
            console.log(`${TAG} 市價補平成功 orderId=${mktDetail.ordId}`);
            lastResult = { success: true, orderId: mktDetail.ordId, rawResponse: JSON.stringify(mktResult) };
            // 查詢市價補平單的成交明細
            if (mktDetail.ordId) {
              const fillDetails = await this.queryOrderFillDetails(instId, mktDetail.ordId);
              if (fillDetails.filledPrice) lastResult.filledPrice = fillDetails.filledPrice;
              if (fillDetails.filledSize) lastResult.filledSize = fillDetails.filledSize;
            }
          } else {
            console.error(`${TAG} 市價補平失敗，fallback closePosition`);
            lastResult = await this.closePosition(symbol, posSide);
          }
          continue;
        }

        // 未成交（live）或其他狀態：取消限價單，fallback 市價
        console.log(`${TAG} 限價單未成交 (state=${state})，取消後市價平倉`);
        await this.cancelOrder(symbol, orderId);
        await new Promise(resolve => setTimeout(resolve, 300));

        // 市價兜底
        lastResult = await this.closePosition(symbol, posSide);
      }

      return lastResult;
    } catch (e: any) {
      console.error(`${TAG} 異常，fallback 市價平倉:`, e?.message);
      return this.closePosition(symbol, posSide);
    }
  }

  async getAccountConfig(): Promise<{ acctLv: string; posMode: string; uid: string }> {
    const data = await this.request("GET", "/api/v5/account/config");
    if (data.code !== "0") {
      throw new Error(`OKX getAccountConfig failed: ${data.msg || data.code}`);
    }
    const cfg = data.data?.[0] || {};
    return {
      acctLv: cfg.acctLv || "unknown",
      posMode: cfg.posMode || "unknown",
      uid: cfg.uid || "",
    };
  }

  async getClosedPnl(
    symbol?: string,
    startTime?: number,
  ): Promise<{ symbol: string; pnl: number; time: number }[]> {
    const params: Record<string, unknown> = {
      instType: "SWAP",
      type: "2", // 平倉
      limit: 100,
    };
    if (symbol) params.instId = this.normalizeSymbol(symbol);
    if (startTime) params.begin = String(startTime);
    const data = await this.request("GET", "/api/v5/account/bills", params);
    if (data.code !== "0") return [];
    return (data.data || []).map((r: any) => ({
      symbol: r.instId,
      pnl: parseFloat(r.pnl || "0"),
      time: parseInt(r.ts),
    }));
  }
}
