import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { registerWebhookRoute } from "../webhook";
import { startRiskMonitor, runRiskCheck } from "../services/riskMonitor";
import { startV35Monitor, runV35Check } from "../services/v35Monitor";
import { startV61Monitor, runV61Check } from "../services/v61Monitor";
import { startV50Monitor, runV50Check } from "../services/v50Monitor";
import { sdk } from "./sdk";
import { initStrategyStudio } from "../services/strategyStudio";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { backtestWsService } from "../services/wsService";
import { scanJobManager } from "../services/backtest/scanEngine";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // TradingView 可能以 text/plain 發送 JSON payload
  app.use(express.text({ limit: "1mb", type: "text/*" }));
  registerWebhookRoute(app);
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // 生產環境（serverless）週期監控：由 Manus Heartbeat 排程 POST 觸發
  // 執行 V3.5 監控（極限止損/移動止盈/馬丁加倉）+ 舊版風控（止損/止盈/每日虧損）
  app.post("/api/scheduled/riskCheck", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user || !user.isCron) {
        return res.status(403).json({ error: "cron-only" });
      }
      await runRiskCheck();
      await runV35Check();
      await runV50Check();
      await runV61Check();
      return res.json({ ok: true, ranAt: new Date().toISOString() });
    } catch (e: any) {
      return res.status(500).json({
        error: e?.message ?? "unknown",
        stack: e?.stack,
        context: { url: req.originalUrl },
        timestamp: new Date().toISOString(),
      });
    }
  });
  // 24/7 自動交易 Heartbeat 回調端點
  // 每次 K 線週期觸發（例如 5 分鐘）產生信號並執行交易
  app.post("/api/scheduled/auto-trade", async (req, res) => {
    try {
      const user = await sdk.authenticateRequest(req);
      if (!user || !user.isCron) {
        return res.status(403).json({ error: "cron-only" });
      }

      const { strategyId } = req.body;
      console.log(`[Heartbeat/AutoTrade] 🔄 Triggered for strategyId=${strategyId} at ${new Date().toISOString()}`);

      if (!strategyId) {
        return res.status(400).json({ error: "Missing strategyId" });
      }

      // 獲取策略配置
      const db = await import("../db").then(m => m.getDb());
      if (!db) {
        return res.status(500).json({ error: "Database unavailable" });
      }

      const { strategies } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const strategyResult = await db.select().from(strategies).where(eq(strategies.id, strategyId)).limit(1);
      const strategy = strategyResult[0];

      if (!strategy) {
        return res.status(404).json({ error: `Strategy ${strategyId} not found` });
      }

      // 檢查策略是否已啟用，disabled 策略不執行交易
      if (!strategy.enabled) {
        console.log(`[Heartbeat/AutoTrade] ⛔ Strategy ${strategyId} (${strategy.name}) is DISABLED, skipping`);
        try {
          const { createHeartbeatLog } = await import("../db");
          await createHeartbeatLog({
            strategyId,
            userId: strategy.userId,
            result: "hold",
            detail: "[disabled] 策略已停用，跳過執行",
          });
        } catch (e) { console.warn("[Heartbeat] Failed to log skipped:", e); }
        return res.json({ ok: true, message: "Strategy disabled, skipped", ranAt: new Date().toISOString() });
      }

      // ===== 止盈/止損/風控檢查（在信號生成前執行，確保每次 heartbeat 觸發都會檢查止盈）=====
      try {
        const strategyKey = (strategy as any).strategyKey || '';
        const isV35Strategy = strategyKey.includes('V35') || strategyKey.includes('KAMA');
        const isV61Strategy = strategyKey.includes('V61');
        
        if (isV35Strategy) {
          const { checkV35Strategy } = await import("../services/v35Monitor");
          const closed = await checkV35Strategy(strategy);
          if (closed) {
            console.log(`[Heartbeat/AutoTrade] 🟢 Strategy ${strategyId}: 止盈/止損已觸發平倉，跳過信號生成`);
            try {
              const { createHeartbeatLog } = await import("../db");
              await createHeartbeatLog({
                strategyId,
                userId: strategy.userId,
                result: "executed",
                detail: "[止盈/止損] 已觸發平倉，由 V35Monitor 執行",
              });
            } catch (e) { console.warn("[Heartbeat] Failed to log TP/SL:", e); }
            return res.json({ ok: true, message: "TP/SL triggered, position closed", ranAt: new Date().toISOString() });
          }
        } else if (isV61Strategy) {
          const { checkV61Strategy } = await import("../services/v61Monitor");
          if (typeof checkV61Strategy === 'function') {
            const closed = await checkV61Strategy(strategy);
            if (closed) {
              console.log(`[Heartbeat/AutoTrade] 🟢 Strategy ${strategyId}: V61 止盈/止損已觸發平倉`);
              try {
                const { createHeartbeatLog } = await import("../db");
                await createHeartbeatLog({
                  strategyId,
                  userId: strategy.userId,
                  result: "executed",
                  detail: "[止盈/止損] 已觸發平倉，由 V61Monitor 執行",
                });
              } catch (e) { console.warn("[Heartbeat] Failed to log TP/SL:", e); }
              return res.json({ ok: true, message: "V61 TP/SL triggered, position closed", ranAt: new Date().toISOString() });
            }
          }
        }
      } catch (e: any) {
        // 止盈/止損檢查失敗不應阻止信號生成，只記錄警告
        console.warn(`[Heartbeat/AutoTrade] ⚠️ TP/SL check failed for ${strategyId}:`, e?.message);
      }

      // 產生交易信號
      const { generateTradingSignal } = await import("../services/autoTradeSignalGenerator");
      const { getApiKeyById } = await import("../db");
      const apiKeyRecord = await getApiKeyById(strategy.apiKeyId);

      if (!apiKeyRecord) {
        return res.status(404).json({ error: "API key not found" });
      }

      const genResult = await generateTradingSignal(
        strategy,
        apiKeyRecord,
        { withReason: true }
      );
      const signal = genResult.signal;

      if (!signal) {
        const holdReason = genResult.holdReason;
        const holdType = holdReason?.type || 'strategy_hold';
        const holdDetailText = holdReason?.detail || 'No signal generated (HOLD)';
        console.log(`[Heartbeat/AutoTrade] ⏸️ Strategy ${strategyId} (${strategy.name}): HOLD - ${holdDetailText}`);
        // Record heartbeat log: HOLD with detailed reason
        try {
          const { createHeartbeatLog } = await import("../db");
          await createHeartbeatLog({
            strategyId,
            userId: strategy.userId,
            result: "hold",
            detail: `[${holdType}] ${holdDetailText}`,
          });
        } catch (e) { console.warn("[Heartbeat] Failed to log HOLD:", e); }
        return res.json({ ok: true, message: holdDetailText, holdType, ranAt: new Date().toISOString() });
      }

      console.log(`[Heartbeat/AutoTrade] ✅ Signal: ${signal.action} ${strategy.symbol} @ ${signal.price}`);

      // 記錄信號
      const { createSignal } = await import("../db");
      const signalId = await createSignal({
        userId: strategy.userId,
        strategyId,
        rawPayload: JSON.stringify(signal),
        parsedAction: signal.action,
        parsedSymbol: strategy.symbol,
        parsedPrice: signal.price?.toString(),
        status: "received",
        source: "auto",
        message: `[Auto] ${signal.action.toUpperCase()} ${strategy.symbol} @ ${signal.price} | reason: ${(signal as any).reason || 'strategy condition met'}`,
      });

      // 執行交易
      const { executeSignal } = await import("../services/executor");
      const parsedSignal = {
        ...signal,
        action: signal.action as "buy" | "sell" | "close",
        symbol: strategy.symbol,
        price: signal.price,
        barTimestamp: signal.barTimestamp,
        reason: (signal as any).reason || `AutoTrade ${strategy.strategyKey || ''}`,
      };

      const result = await executeSignal(strategy, parsedSignal, signalId);
      console.log(`[Heartbeat/AutoTrade] 💰 Execution result: status=${result.status} orderId=${result.orderId || 'none'} msg=${result.message}`);

      // 更新信號狀態
      const { updateSignal } = await import("../db");
      const signalStatus = result.status === "executed" ? "executed" : result.status === "failed" ? "failed" : "skipped";
      await updateSignal(signalId, {
        status: signalStatus,
        message: `[Auto] ${result.message}`,
        orderId: result.orderId,
      });

      // 發送 Telegram 通知
      try {
        const { telegramNotifier } = await import("../services/telegramNotifier");
        if (result.status === "executed") {
          await telegramNotifier.sendExecutionNotification({
            strategyId,
            strategyName: strategy.name,
            symbol: strategy.symbol,
            action: signal.action === "buy" ? "BUY" : "SELL",
            quantity: 0,
            price: signal.price || 0,
            orderId: result.orderId || "pending",
            status: "success",
          });
        } else if (result.status === "failed") {
          await telegramNotifier.sendErrorNotification({
            strategyId,
            strategyName: strategy.name,
            symbol: strategy.symbol,
            error: result.message,
            severity: "high",
          });
        }
      } catch (e) {
        console.warn("[Heartbeat] Telegram notification failed:", e);
      }

      // Record heartbeat log based on execution result
      try {
        const { createHeartbeatLog } = await import("../db");
        const logResult = result.status === "executed" ? "executed" : result.status === "failed" ? "failed" : "signal";
        await createHeartbeatLog({
          strategyId,
          userId: strategy.userId,
          result: logResult as any,
          signalAction: signal.action,
          signalPrice: signal.price?.toString() || null,
          detail: `${signal.action.toUpperCase()} @ ${signal.price || 'market'} → ${result.status}: ${result.message}`,
        });
      } catch (e) { console.warn("[Heartbeat] Failed to log result:", e); }

      return res.json({
        ok: true,
        signal: {
          id: signalId,
          action: signal.action,
          price: signal.price,
        },
        execution: result,
        ranAt: new Date().toISOString(),
      });
    } catch (e: any) {
      // Record heartbeat log: error
      try {
        const { createHeartbeatLog } = await import("../db");
        const sId = req.body?.strategyId;
        if (sId) {
          await createHeartbeatLog({
            strategyId: sId,
            userId: 0,
            result: "error",
            errorMessage: e?.message || "Unknown error",
          });
        }
      } catch (_) {}
      return res.status(500).json({
        error: e?.message ?? "unknown",
        stack: e?.stack,
        context: { url: req.originalUrl },
        timestamp: new Date().toISOString(),
      });
    }
  });

  // 診斷端點：検測部署環境對交易所的對外連線（公開、只讀、不涉及金鑰）
  app.get("/api/diag/exchange", async (_req, res) => {
    const probe = async (name: string, url: string) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const text = await r.text();
        return { name, status: r.status, ok: r.ok, snippet: text.slice(0, 120) };
      } catch (e: any) {
        return { name, status: 0, ok: false, snippet: e?.message ?? "fetch failed" };
      }
    };
    const results = await Promise.all([
      probe("bybit", "https://api.bybit.com/v5/market/time"),
      probe("okx", "https://www.okx.com/api/v5/public/time"),
    ]);
    res.json({ results, ranAt: new Date().toISOString() });
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // 初始化 WebSocket 回測進度推送服務
  backtestWsService.init(server);

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // 啟動風險監控循環（止損/止盈/每日虧損自動執行）
  startRiskMonitor();
  startV35Monitor();
  startV50Monitor();
  startV61Monitor();
  // 策略工作室：註冊內建策略 + 從 DB 重載自訂策略（冷啟動自動重建）
  initStrategyStudio().catch((e) =>
    console.warn("[StrategyStudio] 初始化失敗:", e?.message),
  );
}

startServer().catch(console.error);
