import { describe, expect, it } from "vitest";
import { isBacktestWebSocketRequest } from "./wsService";

describe("回測 WebSocket upgrade 隔離", () => {
  it("只接管精確 /ws，並允許 query string", () => {
    expect(isBacktestWebSocketRequest("/ws")).toBe(true);
    expect(isBacktestWebSocketRequest("/ws?jobId=42")).toBe(true);
  });

  it("不接管 Vite HMR 或相似但不同的路徑", () => {
    expect(isBacktestWebSocketRequest("/")).toBe(false);
    expect(isBacktestWebSocketRequest("/@vite/client")).toBe(false);
    expect(isBacktestWebSocketRequest("/ws/extra")).toBe(false);
    expect(isBacktestWebSocketRequest(undefined)).toBe(false);
  });
});
