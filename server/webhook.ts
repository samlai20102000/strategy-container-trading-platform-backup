import type { Express, Request, Response } from "express";
import { getStrategyById } from "./db";
import { processWebhookSignal } from "./services/executor";

/**
 * TradingView Webhook 接收端點
 * 路由：POST /api/webhook/:strategyId
 * 驗證方式（三選一，任一符合即可）：
 *   1. Query string: ?secret=xxx
 *   2. Header: X-Webhook-Secret: xxx
 *   3. Payload 內: { "secret": "xxx", ... }
 *
 * TradingView Alert message 範例：
 *   { "action": "buy", "symbol": "{{ticker}}", "price": {{close}}, "secret": "your_secret" }
 */
export function registerWebhookRoute(app: Express) {
  app.post("/api/webhook/:strategyId", async (req: Request, res: Response) => {
    try {
      const strategyId = parseInt(req.params.strategyId, 10);
      const payload = req.body ?? {};
      const rawBody =
        typeof payload === "string" ? payload : JSON.stringify(payload);

      // 支援 TradingView 純文字 JSON（content-type: text/plain）
      let parsedPayload = payload;
      if (typeof payload === "string") {
        try {
          parsedPayload = JSON.parse(payload);
        } catch {
          parsedPayload = {};
        }
      }

      const providedSecret =
        (req.query.secret as string | undefined) ||
        (req.headers["x-webhook-secret"] as string | undefined) ||
        (parsedPayload?.secret as string | undefined);

      const strategy = Number.isFinite(strategyId)
        ? await getStrategyById(strategyId)
        : undefined;

      const result = await processWebhookSignal(
        strategy,
        rawBody,
        parsedPayload,
        providedSecret,
      );

      res.status(result.ok ? 200 : 400).json({
        ok: result.ok,
        message: result.message,
      });
    } catch (e: any) {
      console.error("[Webhook] 處理失敗:", e.message);
      res.status(500).json({ ok: false, message: "伺服器內部錯誤" });
    }
  });

  // TradingView 也可能發送 text/plain，補上解析
  app.use("/api/webhook", (req, _res, next) => {
    next();
  });
}
