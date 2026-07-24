import crypto from "crypto";

/**
 * AES-256-GCM 加密工具
 * 用於加密儲存交易所 API Key / Secret / Passphrase
 * 加密金鑰衍生自 JWT_SECRET（系統環境變數，不會外洩至前端）
 */

function getEncryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured; cannot derive encryption key");
  }
  // 以 SHA-256 衍生固定 32 bytes 金鑰
  return crypto.createHash("sha256").update(`aes-key:${secret}`).digest();
}

/**
 * 加密明文，回傳格式：iv(hex).authTag(hex).ciphertext(hex)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${authTag.toString("hex")}.${encrypted.toString("hex")}`;
}

/**
 * 解密密文
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * 產生隨機 webhook secret token
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * 遮蔽金鑰顯示（僅顯示前 4 與後 4 字元）
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
