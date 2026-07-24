import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import axios from "axios";
import { TelegramNotifier } from "./services/telegramNotifier";

// Mock axios globally for this test file
vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
  },
}));

describe("Telegram Notifier", () => {
  let notifier: TelegramNotifier;
  const originalTelegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalTelegramChatId = process.env.TELEGRAM_CHAT_ID;

  beforeAll(() => {
    // Set dummy environment variables for testing
    process.env.TELEGRAM_BOT_TOKEN = "test_bot_token";
    process.env.TELEGRAM_CHAT_ID = "test_chat_id";
    notifier = new TelegramNotifier();
  });

  afterEach(() => {
    // Reset mocks after each test
    vi.clearAllMocks();
  });

  it("should send a test message successfully", async () => {
    // Mock axios.post to resolve successfully
    (axios.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 200,
      data: { ok: true, result: { message_id: 123 } },
    });

    const message = "This is a test message from Vitest.";
    const result = await notifier.send({ message, type: "signal" });

    expect(result).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: `🚀 ${message}`,
        parse_mode: "HTML",
      },
      { timeout: 5000 }
    );
  });

  it("should return false if sending message fails", async () => {
    // Mock axios.post to reject
    (axios.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      response: {
        status: 400,
        data: { ok: false, description: "Bad Request" },
      },
    });

    const message = "This is a failing test message.";
    const result = await notifier.send({ message, type: "signal" });

    expect(result).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
});
