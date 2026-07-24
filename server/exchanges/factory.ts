import type { ApiKey } from "../../drizzle/schema";
import { decrypt } from "../lib/crypto";
import { BybitAdapter } from "./bybit";
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
>;

export function createAdapter(apiKeyRecord: AdapterCredentials): ExchangeAdapter {
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
  }

  if (apiKeyRecord.exchange === "okx") {
    if (!apiKeyRecord.passphraseEncrypted) {
      throw new Error("OKX API 金鑰缺少 passphrase");
    }
    const passphrase = decrypt(apiKeyRecord.passphraseEncrypted);
    return new OKXAdapter(apiKey, apiSecret, passphrase, apiKeyRecord.isTestnet);
  }

  throw new Error(`不支援的交易所: ${apiKeyRecord.exchange}`);
}
