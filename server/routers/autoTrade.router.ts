/**
 * Auto-Trade Router
 * Handles 24/7 automated trading via Manus Heartbeat
 * 
 * Flow:
 * 1. Heartbeat triggers POST /api/scheduled/auto-trade
 * 2. Generate trading signals from real-time OKX data
 * 3. Execute trades based on strategy configuration
 * 4. Send Telegram notifications
 * 5. Record signals and trades in database
 */

import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { generateTradingSignal, generateSignalsForMultiplePairs } from "../services/autoTradeSignalGenerator";
import { executeSignal } from "../services/executor";
import { telegramNotifier } from "../services/telegramNotifier";
import { getStrategy } from "../services/strategyStudio";
import * as db from "../db";
import { createAdapter } from "../exchanges/factory";
import { decrypt } from "../lib/crypto";
import {
  setupHeartbeatForStrategy,
  disableHeartbeatForStrategy,
  deleteHeartbeatForStrategy,
  listHeartbeatTasks,
} from "../services/heartbeatManager";

// Import apiKeys from schema
import { apiKeys } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * Helper function to get API key by ID
 */
async function getApiKeyByIdHelper(id: number) {
  const dbInstance = await db.getDb();
  if (!dbInstance) return undefined;
  const result = await dbInstance.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  return result[0];
}

export const autoTradeRouter = router({
  /**
   * Generate signals for a single trading pair
   * Called by Heartbeat task for each pair
   */
  generateSignal: publicProcedure
    .input(
      z.object({
        strategyId: z.number(),
        symbol: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const { strategyId, symbol } = input;
        const strategy = await db.getStrategyById(strategyId, 0); // system call, userId=0 bypass
        if (!strategy) {
          return { success: false, message: `Strategy ${strategyId} not found` };
        }

        const apiKeyRecord = await getApiKeyByIdHelper(strategy.apiKeyId);
        if (!apiKeyRecord) {
          return { success: false, message: `API key not found for strategy ${strategyId}` };
        }

        // Generate signal using the strategy's configured engine
        const signal = await generateTradingSignal(strategy, apiKeyRecord);

        if (!signal) {
          return {
            success: true,
            signal: null,
            message: "No signal generated (HOLD)",
          };
        }

        // Record signal to database
        await db.createSignal({
          userId: strategy.userId,
          strategyId,
          rawPayload: JSON.stringify(signal),
          parsedAction: signal.action,
          parsedSymbol: symbol,
          parsedPrice: signal.price?.toString(),
          status: "received",
          source: "auto",
          message: `Auto-trade signal: ${signal.action} @ ${signal.price || 'market'}`,
        });

        // Send Telegram notification
        try {
          await telegramNotifier.sendSignalNotification({
            strategyId: strategyId,
            strategyName: strategy.name,
            symbol,
            action: signal.action === "buy" ? "BUY" : "SELL",
            price: signal.price || 0,
            confidence: signal.confidence || 0.5,
            reason: signal.reason || "Auto-trade signal",
          });
        } catch (notifyErr) {
          console.error("[autoTrade.generateSignal] Telegram notification failed:", notifyErr);
        }

        return {
          success: true,
          signal: {
            action: signal.action,
            price: signal.price,
            confidence: signal.confidence,
          },
          message: `Signal: ${signal.action} @ ${signal.price || 'market'}`,
        };
      } catch (err: any) {
        console.error("[autoTrade.generateSignal] Error:", err);
        return { success: false, message: err.message || "Unknown error" };
      }
    }),

  /**
   * Execute a signal action (place order)
   */
  executeSignalAction: protectedProcedure
    .input(
      z.object({
        strategyId: z.number(),
        action: z.enum(["buy", "sell", "close"]),
        symbol: z.string(),
        price: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { strategyId, action, symbol, price } = input;
        const strategy = await db.getStrategyById(strategyId, ctx.user!.id);
        if (!strategy) {
          return { status: "failed" as const, message: `Strategy ${strategyId} not found` };
        }

        // Create a signal record first
        const signalRecord = await db.createSignal({
          userId: strategy.userId,
          strategyId,
          rawPayload: JSON.stringify({ action, symbol, price }),
          parsedAction: action,
          parsedSymbol: symbol,
          parsedPrice: price?.toString(),
          status: "received",
          message: `Manual execution: ${action}`,
        });

        // Execute the signal
        const parsedSignal = { action, symbol, price, reason: `ManualExec ${strategy.strategyKey || ''}` };
        const result = await executeSignal(strategy, parsedSignal, signalRecord);

        // 更新信號狀態（與自動交易路徑一致）
        const signalStatus = result.status === "executed" ? "executed" : result.status === "failed" ? "failed" : "skipped";
        await db.updateSignal(signalRecord, {
          status: signalStatus,
          message: `[ManualExec] ${result.message}`,
          orderId: result.orderId,
        });

        // Send Telegram notification
        try {
          if (result.status === "executed") {
            await telegramNotifier.sendExecutionNotification({
              strategyId,
              strategyName: strategy.name,
              symbol,
              action: action === "buy" ? "BUY" : "SELL",
              quantity: 0,
              price: price || 0,
              orderId: result.orderId || "unknown",
              status: "success",
            });
          }
        } catch (notifyErr) {
          console.error("[autoTrade.executeSignalAction] Telegram notification failed:", notifyErr);
        }

        return result;
      } catch (err: any) {
        return { status: "failed" as const, message: err.message || "Unknown error" };
      }
    }),

  /**
   * Get auto-trade status for all strategies
   */
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const strategies = await db.listStrategies(ctx.user!.id);
    return strategies.map((s) => ({
      id: s.id,
      name: s.name,
      symbol: s.symbol,
      enabled: s.enabled,
      tradeMode: (s as any).tradeMode || "webhook",
      heartbeatTaskUid: (s as any).heartbeatTaskUid || null,
      kLinePeriod: (s as any).kLinePeriod || 15,
    }));
  }),

  /**
   * Enable auto-trade mode for a strategy (create Heartbeat task)
   */
  createHeartbeatTask: protectedProcedure
    .input(
      z.object({
        strategyId: z.number(),
        kLinePeriod: z.number().default(15),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { strategyId, kLinePeriod } = input;
      const strategy = await db.getStrategyById(strategyId, ctx.user!.id);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      // Create real Heartbeat task via Manus API
      try {
        const result = await setupHeartbeatForStrategy(
          {
            strategyId,
            symbol: strategy.symbol,
            kLinePeriod,
            enabled: true,
            taskUid: (strategy as any).heartbeatTaskUid || undefined,
          },
          ctx.sessionToken
        );

        // Persist taskUid and update trade mode
        await db.updateStrategy(strategyId, ctx.user!.id, {
          enabled: true,
          tradeMode: "auto",
          heartbeatTaskUid: result.taskUid,
          kLinePeriod,
        } as any);

        return { success: true, strategyId, kLinePeriod, taskUid: result.taskUid };
      } catch (err: any) {
        console.error("[autoTrade.createHeartbeatTask] Failed:", err);
        // Fallback: just update mode without real task
        await db.updateStrategy(strategyId, ctx.user!.id, {
          enabled: true,
          tradeMode: "auto",
          kLinePeriod,
        } as any);
        return { success: true, strategyId, kLinePeriod, taskUid: null, warning: err.message };
      }
    }),

  /**
   * Toggle Heartbeat task (enable/disable auto-trade)
   */
  toggleHeartbeatTask: protectedProcedure
    .input(
      z.object({
        strategyId: z.number(),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { strategyId, enabled } = input;
      const strategy = await db.getStrategyById(strategyId, ctx.user!.id);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      const taskUid = (strategy as any).heartbeatTaskUid;

      // Toggle real Heartbeat task if taskUid exists
      if (taskUid) {
        try {
          if (enabled) {
            await setupHeartbeatForStrategy(
              {
                strategyId,
                symbol: strategy.symbol,
                kLinePeriod: (strategy as any).kLinePeriod || 15,
                enabled: true,
                taskUid,
              },
              ctx.sessionToken
            );
          } else {
            await disableHeartbeatForStrategy(taskUid, ctx.sessionToken);
          }
        } catch (err: any) {
          console.error("[autoTrade.toggleHeartbeatTask] Heartbeat API error:", err.message);
        }
      }

      await db.updateStrategy(strategyId, ctx.user!.id, { enabled });
      return { success: true, enabled };
    }),

  /**
   * Switch back to webhook mode (delete Heartbeat task)
   */
  deleteHeartbeatTask: protectedProcedure
    .input(
      z.object({
        strategyId: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { strategyId } = input;
      const strategy = await db.getStrategyById(strategyId, ctx.user!.id);
      if (!strategy) {
        throw new Error(`Strategy ${strategyId} not found`);
      }

      const taskUid = (strategy as any).heartbeatTaskUid;

      // Delete real Heartbeat task if taskUid exists
      if (taskUid) {
        try {
          await deleteHeartbeatForStrategy(taskUid, ctx.sessionToken);
        } catch (err: any) {
          console.error("[autoTrade.deleteHeartbeatTask] Heartbeat API error:", err.message);
        }
      }

      // Switch back to webhook mode
      await db.updateStrategy(strategyId, ctx.user!.id, {
        tradeMode: "webhook",
        heartbeatTaskUid: null,
      } as any);

      return { success: true };
    }),

  /**
   * Manually trigger signal generation for a strategy
   */
  triggerHeartbeatTask: protectedProcedure
    .input(
      z.object({
        strategyId: z.number(),
        symbol: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const { strategyId, symbol } = input;
        const strategy = await db.getStrategyById(strategyId, ctx.user!.id);
        if (!strategy) {
          throw new Error(`Strategy ${strategyId} not found`);
        }
        const apiKeyRecord = await getApiKeyByIdHelper(strategy.apiKeyId);
        if (!apiKeyRecord) {
          throw new Error(`API key not found for strategy ${strategyId}`);
        }
        const genResult = await generateTradingSignal(strategy, apiKeyRecord, { withReason: true });
        const signal = genResult.signal;
        if (!signal) {
          const holdReason = genResult.holdReason;
          const holdType = holdReason?.type || 'strategy_hold';
          const holdDetailText = holdReason?.detail || 'No signal generated (HOLD)';
          // 記錄 heartbeat log
          try {
            await db.createHeartbeatLog({
              strategyId,
              userId: strategy.userId,
              result: "hold",
              detail: `[${holdType}] ${holdDetailText}`,
            });
          } catch (e) { /* ignore */ }
          return { success: false, message: holdDetailText, holdType };
        }
        // Record signal
        const signalId = await db.createSignal({
          userId: strategy.userId,
          strategyId,
          rawPayload: JSON.stringify(signal),
          parsedAction: signal.action,
          parsedSymbol: symbol,
          parsedPrice: signal.price?.toString(),
          status: "received",
          source: "manual",
          message: `[ManualTrigger] ${signal.action.toUpperCase()} ${symbol} @ ${signal.price} | reason: ${(signal as any).reason || 'strategy condition met'}`,
        });

        // Execute trade (same logic as Heartbeat endpoint)
        const { executeSignal } = await import("../services/executor");
        const parsedSignal = {
          action: signal.action as "buy" | "sell" | "close",
          symbol: strategy.symbol,
          price: signal.price,
          barTimestamp: signal.barTimestamp,
          reason: (signal as any).reason || `ManualTrigger ${strategy.strategyKey || ''}`,
        };
        const result = await executeSignal(strategy, parsedSignal, signalId);

        // 更新信號狀態（與自動交易路徑一致）
        const signalStatus = result.status === "executed" ? "executed" : result.status === "failed" ? "failed" : "skipped";
        await db.updateSignal(signalId, {
          status: signalStatus,
          message: `[ManualTrigger] ${result.message}`,
          orderId: result.orderId,
        });

        // Send Telegram notification
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
          }
        } catch (e) {
          console.warn("[triggerHeartbeatTask] Telegram notification failed:", e);
        }

        return {
          success: true,
          signal: {
            action: signal.action,
            price: signal.price,
          },
          execution: result,
          message: `Signal: ${signal.action} @ ${signal.price || 'market'} | Execution: ${result.status} - ${result.message}`,
        };
      } catch (err: any) {
        return { success: false, message: err.message || "Unknown error" };
      }
    }),

  /**
   * List heartbeat polling logs for a strategy
   */
  listHeartbeatLogs: protectedProcedure
    .input(
      z.object({
        strategyId: z.number(),
        limit: z.number().min(1).max(100).default(10),
        offset: z.number().min(0).default(0),
        excludeHold: z.boolean().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      // Verify strategy ownership
      const strategy = await db.getStrategyById(input.strategyId, ctx.user!.id);
      if (!strategy) {
        throw new Error(`Strategy ${input.strategyId} not found`);
      }
      return db.listHeartbeatLogs(input.strategyId, {
        limit: input.limit,
        offset: input.offset,
        excludeHold: input.excludeHold,
      });
    }),

  /**
   * Check OKX account mode compatibility
   * Returns account level info to verify trading mode is compatible
   */
  checkAccountMode: protectedProcedure
    .input(z.object({ strategyId: z.number() }))
    .query(async ({ input, ctx }) => {
      const strategy = await db.getStrategyById(input.strategyId, ctx.user!.id);
      if (!strategy) {
        throw new Error(`Strategy ${input.strategyId} not found`);
      }
      const apiKeyRecord = await getApiKeyByIdHelper(strategy.apiKeyId);
      if (!apiKeyRecord) {
        throw new Error(`API key not found for strategy ${input.strategyId}`);
      }
      if (apiKeyRecord.exchange !== "okx") {
        return { compatible: true, exchange: apiKeyRecord.exchange, message: "Non-OKX exchange, no mode check needed" };
      }
      try {
        const adapter = createAdapter(apiKeyRecord);
        // OKX adapter should expose getAccountConfig
        const config = await (adapter as any).getAccountConfig();
        // acctLv: 1=simple, 2=single-currency margin, 3=multi-currency margin, 4=portfolio margin
        const acctLv = config?.acctLv || "unknown";
        const posMode = config?.posMode || "unknown";
        // For perpetual swap trading, need acctLv >= 2 and posMode should be "long_short_mode"
        const compatible = Number(acctLv) >= 2;
        return {
          compatible,
          exchange: "okx",
          acctLv,
          posMode,
          message: compatible
            ? `帳戶模式正常（Level ${acctLv}，${posMode === "long_short_mode" ? "雙向持倉" : "單向持倉"}）`
            : `帳戶模式不兼容：當前為 Level ${acctLv}（需要 Level 2+，請在 OKX 切換為保證金交易模式）`,
        };
      } catch (err: any) {
        return {
          compatible: false,
          exchange: "okx",
          message: `檢測失敗：${err.message}`,
        };
      }
    }),

  /**
   * Get heartbeat status for all strategies (enriched with execution info)
   */
  getHeartbeatStatus: protectedProcedure.query(async ({ ctx }) => {
    try {
      const strategies = await db.listStrategies(ctx.user?.id || 0);

      const statuses = await Promise.all(
        strategies.map(async (strategy) => {
          const recentSignals = await db.listSignals(strategy.userId, {
            strategyId: strategy.id,
            limit: 1,
            offset: 0,
          });

          const recentTrades = await db.listTrades(strategy.userId, {
            strategyId: strategy.id,
            limit: 1,
          });

          const kLinePeriod = (strategy as any).kLinePeriod || 15;
          const tradeMode = (strategy as any).tradeMode || "webhook";
          const heartbeatTaskUid = (strategy as any).heartbeatTaskUid || null;

          return {
            strategyId: strategy.id,
            strategyName: strategy.name,
            status: strategy.enabled ? "running" : "stopped",
            symbol: strategy.symbol,
            tradeMode,
            heartbeatTaskUid,
            kLinePeriod,
            lastSignalTime: recentSignals.items[0]?.createdAt,
            lastTradeTime: recentTrades[0]?.createdAt,
          };
        })
      );

      return {
        timestamp: new Date().toISOString(),
        strategiesProcessed: strategies.length,
        statuses,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      console.error("[autoTrade.getHeartbeatStatus] Error:", error);
      throw err;
    }
  }),
});
