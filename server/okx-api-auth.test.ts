import { describe, it, expect, vi } from "vitest";
import { createAdapter } from "./exchanges/factory";
import { ENV } from "./_core/env";

// Mock the decrypt function globally for server/lib/crypto.ts
vi.mock("../server/lib/crypto", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    decrypt: vi.fn((encryptedValue: string) => encryptedValue),
  };
});

describe("OKX API Authentication Test", () => {
  it("should successfully connect to OKX testnet with provided credentials", async () => {
    const RUN_OKX_AUTH_TEST = process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE;

    if (!RUN_OKX_AUTH_TEST) {
      console.warn("Skipping OKX API authentication test: OKX_API_KEY, OKX_API_SECRET, or OKX_API_PASSPHRASE not set.");
      return;
    }

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
  }, 30000); // 30 seconds timeout for API call
});
