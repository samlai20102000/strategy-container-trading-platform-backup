/**
 * WebSocket 回測進度推送服務（V4.4）
 * 提供即時回測進度推送，替代前端輪詢機制
 * 
 * 協議：
 * - 連接路徑：ws://host/ws
 * - 客戶端發送：{ type: "subscribe", jobId: string }
 * - 服務端推送：{ type: "progress", jobId: string, progress: number, status: string, ... }
 * - 服務端推送：{ type: "complete", jobId: string, result: {...} }
 * - 服務端推送：{ type: "error", jobId: string, error: string }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";

export function isBacktestWebSocketRequest(rawUrl: string | undefined): boolean {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname === "/ws";
  } catch {
    return false;
  }
}

interface WsClient {
  ws: WebSocket;
  subscribedJobs: Set<string>;
}

class BacktestWsService {
  private wss: WebSocketServer | null = null;
  private clients: Set<WsClient> = new Set();

  /**
   * 初始化 WebSocket 服務，掛載到現有 HTTP server
   */
  init(server: HttpServer): void {
    if (this.wss) return; // 防止重複初始化

    // 使用 noServer 並只接管精確 /ws。若直接傳入 { server, path }，ws 套件仍會
    // 監聽所有 upgrade，並對非 /ws 請求回 400；這會中止同一 HTTP server 上的
    // Vite HMR 或平台代理 WebSocket，造成開發頁反覆重載／白畫面。
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (!isBacktestWebSocketRequest(request.url)) return;
      const wss = this.wss;
      if (!wss) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, ws => {
        wss.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (ws) => {
      const client: WsClient = { ws, subscribedJobs: new Set() };
      this.clients.add(client);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "subscribe" && msg.jobId) {
            client.subscribedJobs.add(msg.jobId);
            // 回覆確認
            ws.send(JSON.stringify({ type: "subscribed", jobId: msg.jobId }));
          } else if (msg.type === "unsubscribe" && msg.jobId) {
            client.subscribedJobs.delete(msg.jobId);
          }
        } catch {
          // 忽略無效消息
        }
      });

      ws.on("close", () => {
        this.clients.delete(client);
      });

      ws.on("error", () => {
        this.clients.delete(client);
      });

      // 發送歡迎消息
      ws.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));
    });

    console.log("[WS] WebSocket 回測進度推送服務已啟動 (path: /ws)");
  }

  /**
   * 推送回測進度更新
   */
  broadcastProgress(jobId: string, progress: number, status: string, extra?: Record<string, any>): void {
    const message = JSON.stringify({
      type: "progress",
      jobId,
      progress,
      status,
      timestamp: Date.now(),
      ...extra,
    });

    Array.from(this.clients).forEach((client) => {
      if (client.subscribedJobs.has(jobId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });
  }

  /**
   * 推送回測完成
   */
  broadcastComplete(jobId: string, result: any): void {
    const message = JSON.stringify({
      type: "complete",
      jobId,
      result,
      timestamp: Date.now(),
    });

    Array.from(this.clients).forEach((client) => {
      if (client.subscribedJobs.has(jobId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
        client.subscribedJobs.delete(jobId); // 完成後自動取消訂閱
      }
    });
  }

  /**
   * 推送回測錯誤
   */
  broadcastError(jobId: string, error: string): void {
    const message = JSON.stringify({
      type: "error",
      jobId,
      error,
      timestamp: Date.now(),
    });

    Array.from(this.clients).forEach((client) => {
      if (client.subscribedJobs.has(jobId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
        client.subscribedJobs.delete(jobId); // 錯誤後自動取消訂閱
      }
    });
  }

  /**
   * 獲取當前連接數
   */
  getConnectionCount(): number {
    return this.clients.size;
  }
}

// 單例導出
export const backtestWsService = new BacktestWsService();
