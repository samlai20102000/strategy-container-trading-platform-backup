import { describe, expect, it } from "vitest";
import { decrypt, encrypt, generateWebhookSecret, maskKey } from "./lib/crypto";
import { parseSignalPayload } from "./services/executor";

describe("crypto 加密工具", () => {
  it("加密後可正確解密還原", () => {
    const plaintext = "my-super-secret-api-key-12345";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("相同明文每次加密產生不同密文（隨機 IV）", () => {
    const plaintext = "same-input";
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1)).toBe(plaintext);
    expect(decrypt(c2)).toBe(plaintext);
  });

  it("密文被竄改時解密失敗（GCM 完整性驗證）", () => {
    const ciphertext = encrypt("sensitive-data");
    const parts = ciphertext.split(".");
    // 竄改密文本體（格式：iv.authTag.data，hex 編碼）
    const tampered = [parts[0], parts[1], "deadbeefdeadbeef"].join(".");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("maskKey 只顯示前後各 4 字元", () => {
    const masked = maskKey("abcdefghijklmnop");
    expect(masked).toBe("abcd****mnop");
    expect(masked).not.toContain("efgh");
  });

  it("generateWebhookSecret 產生足夠長度的隨機字串", () => {
    const s1 = generateWebhookSecret();
    const s2 = generateWebhookSecret();
    expect(s1.length).toBeGreaterThanOrEqual(32);
    expect(s1).not.toBe(s2);
  });
});

describe("parseSignalPayload 訊號解析", () => {
  it("解析標準 buy 訊號", () => {
    const result = parseSignalPayload({
      action: "buy",
      symbol: "BTCUSDT",
      price: 62450.5,
    });
    expect(result).toEqual({ action: "buy", symbol: "BTCUSDT", price: 62450.5 });
  });

  it("解析 sell 與 close 訊號", () => {
    expect(parseSignalPayload({ action: "sell" })?.action).toBe("sell");
    expect(parseSignalPayload({ action: "close" })?.action).toBe("close");
  });

  it("支援 side / signal 欄位變體", () => {
    expect(parseSignalPayload({ side: "buy" })?.action).toBe("buy");
    expect(parseSignalPayload({ signal: "SELL" })?.action).toBe("sell");
  });

  it("支援 long/short/exit 別名", () => {
    expect(parseSignalPayload({ action: "long" })?.action).toBe("buy");
    expect(parseSignalPayload({ action: "short" })?.action).toBe("sell");
    expect(parseSignalPayload({ action: "exit" })?.action).toBe("close");
    expect(parseSignalPayload({ action: "flat" })?.action).toBe("close");
  });

  it("price 為字串時可轉為數字", () => {
    const result = parseSignalPayload({ action: "buy", price: "12345.67" });
    expect(result?.price).toBe(12345.67);
  });

  it("無效 payload 回傳 null", () => {
    expect(parseSignalPayload(null)).toBeNull();
    expect(parseSignalPayload({})).toBeNull();
    expect(parseSignalPayload({ action: "hold" })).toBeNull();
    expect(parseSignalPayload("not-an-object")).toBeNull();
  });

  it("price 非數字時忽略 price 欄位", () => {
    const result = parseSignalPayload({ action: "buy", price: "abc" });
    expect(result?.action).toBe("buy");
    expect(result?.price).toBeUndefined();
  });
});
