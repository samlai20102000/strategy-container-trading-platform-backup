import type { ApiKey } from "../../drizzle/schema";
import { decrypt } from "../lib/crypto";
import { BybitAdapter } from "./bybit";
import { createMakerFirstAdapter } from "./makerFirstFacade";
import { OKXAdapter } from "./okx";
import type { ExchangeAdapter } from "./types";

/**
 * 依據資料庫中的 API 金鑰記錄建立對應的交易所轉接器
 * 金鑰於此處即時解密，僅存在於記憶體中
 */
/** 建立轉接器所需的最小欄位集（完整 ApiKey 記錄或臨時憑證皆可） */
export type AdapterCredentials = Pick<
  ApiKey,
  "exchange" | "apiKeyEncrypted" | "apiSecretEncrypted" | "passphraseEncrypted" | "isTestnet"
> & Partial<Pick<ApiKey, "id" | "userId">>;

function createRawAdapter(apiKeyRecord: AdapterCredentials): ExchangeAdapter {
  let apiKey: string;
  let apiSecret: string;
  try {
    apiKey = decrypt(apiKeyRecord.apiKeyEncrypted);
    apiSecret = decrypt(apiKeyRecord.apiSecretEncrypted);
    console.log(`[createAdapter] 成功解密 ${apiKeyRecord.exchange} 金鑰（長度：key=${apiKey.length}, secret=${apiSecret.length}）`);
  } catch (e: any) {
    console.error(`[createAdapter] 解密失敗：${e.message}`);
    console.error(`[createAdapter] 加密文本長度：key=${apiKeyRecord.apiKeyEncrypted?.length}, secret=${apiKeyRecord.apiSecretEncrypted?.length}`);
    throw new Error(`API 金鑰解密失敗：${e.message}`);
  }

  if (apiKeyRecord.exchange === "bybit") {
    return new BybitAdapter(apiKey, apiSecret, apiKeyRecord.isTestnet);
  } else if (apiKeyRecord.exchange === "okx") {
    if (!apiKeyRecord.passphraseEncrypted) {
      throw new Error("OKX API 金鑰缺少 passphrase");
    }
    const passphrase = decrypt(apiKeyRecord.passphraseEncrypted);
    return new OKXAdapter(apiKey, apiSecret, passphrase, apiKeyRecord.isTestnet);
  } else {
    throw new Error(`不支援的交易所: ${apiKeyRecord.exchange}`);
  }
}

export function createAdapter(apiKeyRecord: AdapterCredentials): ExchangeAdapter {
  const rawAdapter = createRawAdapter(apiKeyRecord);

  // 唯一建立入口即強制套用全域方案 B。缺少 owner/API key 身分時仍可使用
  // readonly／connection probe，但任何 mutation 會由 facade fail-closed 拒絕。
  return createMakerFirstAdapter(rawAdapter, {
    userId: Number(apiKeyRecord.userId ?? 0),
    apiKeyId: Number(apiKeyRecord.id ?? 0),
  });
}

/**
 * 僅供 orderPolicyRecovery 使用：接續既有 policyRunId 時不得再建立第二層 facade。
 * 架構守衛會拒絕此函式出現在任何其他生產檔案。
 */
export function createNativeAdapterForOrderPolicyRecovery(
  apiKeyRecord: AdapterCredentials,
): ExchangeAdapter {
  return createRawAdapter(apiKeyRecord);
}
