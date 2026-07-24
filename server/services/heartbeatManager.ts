/**
 * Dynamic Heartbeat Task Manager
 * Supports multiple trading pairs, variable K-line periods, automatic signal generation and trade execution
 * 
 * Core features:
 * 1. Create independent Heartbeat tasks for each trading pair
 * 2. Dynamically adjust task frequency based on user-configured K-line period
 * 3. Automatically generate trading signals (entry, add position, take profit)
 * 4. Call executor.ts to execute trades
 * 5. Send Telegram notifications
 */

import { createHeartbeatJob, updateHeartbeatJob, deleteHeartbeatJob, listHeartbeatJobs } from "../_core/heartbeat";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { strategies } from "../../drizzle/schema";

export interface HeartbeatConfig {
  strategyId: number;
  symbol: string;
  kLinePeriod: number; // 5, 15, 60, 240 (minutes)
  enabled: boolean;
  taskUid?: string; // Manus Heartbeat task UID
}

/**
 * Fixed 1-minute cron expression for all auto-trade tasks.
 * 
 * Rationale: Regardless of the strategy's K-line period (5m, 15m, 1H, etc.),
 * we poll every 1 minute to achieve near-real-time signal detection.
 * 
 * The strategy engine itself uses the configured K-line period data for analysis,
 * but we CHECK every minute whether conditions are met. This means:
 * - Maximum signal latency: ~1 minute (instead of waiting for the full K-line period)
 * - When the 3rd candle closes and conditions are met, the next 1-min poll detects it
 * - The K-line period setting only affects which timeframe data is analyzed, NOT trigger frequency
 */
const FIXED_1MIN_CRON = "0 * * * * *"; // Every minute at second 0

/**
 * Create or update Heartbeat task
 */
export async function setupHeartbeatForStrategy(
  config: HeartbeatConfig,
  userSession: string
): Promise<{ taskUid: string }> {
  const cron = FIXED_1MIN_CRON; // Always poll every 1 minute for near-real-time detection
  const jobName = `auto-trade-${config.strategyId}-${config.symbol.replace('/', '-')}`;
  const description = `Auto-trade: ${config.symbol} (analyse ${config.kLinePeriod}min K-line, poll every 1min)`;
  
  // If task already exists, update it
  if (config.taskUid) {
    await updateHeartbeatJob(
      config.taskUid,
      {
        cron,
        description,
        enable: config.enabled,
      },
      userSession
    );
    return { taskUid: config.taskUid };
  }
  
  // Otherwise create new task
  const result = await createHeartbeatJob(
    {
      name: jobName,
      cron,
      path: "/api/scheduled/auto-trade",
      method: "POST",
      payload: {
        strategyId: config.strategyId,
        symbol: config.symbol,
        kLinePeriod: config.kLinePeriod,
      },
      description,
    },
    userSession
  );
  
  // Note: taskUid will be stored in the caller's context or a separate heartbeat_tasks table
  // For now, we just return it and let the caller handle persistence
  
  return { taskUid: result.taskUid };
}

/**
 * Disable Heartbeat task
 */
export async function disableHeartbeatForStrategy(
  taskUid: string,
  userSession: string
): Promise<void> {
  if (!taskUid) return;
  await updateHeartbeatJob(taskUid, { enable: false }, userSession);
}

/**
 * Delete Heartbeat task
 */
export async function deleteHeartbeatForStrategy(
  taskUid: string,
  userSession: string
): Promise<void> {
  if (!taskUid) return;
  await deleteHeartbeatJob(taskUid, userSession);
}

/**
 * List all Heartbeat tasks
 */
export async function listHeartbeatTasks(
  userSession: string
): Promise<any[]> {
  const result = await listHeartbeatJobs(userSession);
  return result.jobs;
}

/**
 * Setup Heartbeat tasks for multiple trading pairs
 */
export async function setupHeartbeatForMultipleSymbols(
  strategyId: number,
  symbols: string[],
  kLinePeriod: number,
  userSession: string
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  
  for (const symbol of symbols) {
    try {
      const result = await setupHeartbeatForStrategy(
        {
          strategyId,
          symbol,
          kLinePeriod,
          enabled: true,
        },
        userSession
      );
      results[symbol] = result.taskUid;
    } catch (error) {
      console.error(`[HeartbeatManager] Failed to setup task for ${symbol}:`, error);
      results[symbol] = `ERROR: ${String(error)}`;
    }
  }
  
  return results;
}
