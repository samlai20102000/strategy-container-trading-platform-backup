import { describe, it, expect, vi } from "vitest";
import { createAdapter } from "./exchanges/factory";

// Mock the decrypt function globally for server/lib/crypto.ts
vi.mock("../server/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    decrypt: vi.fn((encryptedValue: string) => encryptedValue),
  };
});

const runOkxLiveAuthTest = process.env.RUN_OKX_LIVE_AUTH_TEST === "1";
const liveAuthIt = runOkxLiveAuthTest ? it : it.skip;

describe("OKX API live authentication integration", () => {
  liveAuthIt("connects to OKX testnet only when explicitly enabled", async () => {
    expect(process.env.OKX_API_KEY, "OKX_API_KEY is required when RUN_OKX_LIVE_AUTH_TEST=1").toBeTruthy();
    expect(process.env.OKX_API_SECRET, "OKX_API_SECRET is required when RUN_OKX_LIVE_AUTH_TEST=1").toBeTruthy();
    expect(process.env.OKX_API_PASSPHRASE, "OKX_API_PASSPHRASE is required when RUN_OKX_LIVE_AUTH_TEST=1").toBeTruthy();

    // Directly use plain text environment variables for testing
    const adapter = createAdapter({
      exchange: "okx",
      apiKeyEncrypted: process.env.OKX_API_KEY!,
      apiSecretEncrypted: process.env.OKX_API_SECRET!,
      passphraseEncrypted: process.env.OKX_API_PASSPHRASE!,
      isTestnet: true,
    });

    // Attempt to get server time as a lightweight authenticated call
    const serverTime = await adapter.getServerTime();
    expect(serverTime).toBeGreaterThan(0);
  }, 30_000);
});
