// server/services/riskManager.ts
// 🔥 V4.0 百分比风险管理 + V3.x 向後兼容 API

import type { StrategyState } from './martingaleEngine';
import {
  V4Config,
  calculateUnrealizedLoss,
  calculateUnrealizedLossPct,
  shouldTriggerLimitStop,
} from './martingaleEngine';

// ============================================================
// V3.x 向後兼容 RiskManager Class
// ============================================================

interface RiskManagerConfig {
  initialCapital: number;
  maxDrawdownPct: number;
  lastLayerDeviationPct?: number; // 條件 B：最後層偏離百分比（默認 3%）
  maxLossUsdt?: number; // 條件 C：絕對金額限損
  maxLossPct?: number; // V3.7：硬止損百分比
}

interface CheckLimitStopInput {
  totalSize: number;
  avgPrice: number;
  currentPrice: number;
  lastLayerPrice: number;
  isLong: boolean;
}

interface CheckLimitStopResult {
  triggered: boolean;
  reason: string;
  estimatedLoss?: number;
}

export class RiskManager {
  private config: RiskManagerConfig;

  constructor(config: RiskManagerConfig) {
    this.config = {
      initialCapital: config.initialCapital,
      maxDrawdownPct: config.maxDrawdownPct,
      lastLayerDeviationPct: config.lastLayerDeviationPct ?? 3,
      maxLossUsdt: config.maxLossUsdt ?? 0,
      maxLossPct: config.maxLossPct ?? 0,
    };
  }

  /**
   * 極限止損檢查（條件 A + B + C）
   */
  checkLimitStop(input: CheckLimitStopInput): CheckLimitStopResult {
    const { totalSize, avgPrice, currentPrice, lastLayerPrice, isLong } = input;

    // 計算浮虧
    let estimatedLoss: number;
    if (isLong) {
      estimatedLoss = (avgPrice - currentPrice) * totalSize;
    } else {
      estimatedLoss = (currentPrice - avgPrice) * totalSize;
    }
    // 如果是盈利，浮虧為 0
    if (estimatedLoss < 0) estimatedLoss = 0;

    // 條件 A：浮虧 >= 初始資本 × maxDrawdownPct%
    const maxDrawdown = this.config.initialCapital * (this.config.maxDrawdownPct / 100);
    if (estimatedLoss >= maxDrawdown) {
      return {
        triggered: true,
        reason: `條件 A：浮虧 ${estimatedLoss.toFixed(2)} USDT ≥ ${maxDrawdown.toFixed(2)} USDT (${this.config.maxDrawdownPct}%)`,
        estimatedLoss,
      };
    }

    // 條件 C：絕對金額限損（maxLossUsdt > 0 時啟用）
    if (this.config.maxLossUsdt && this.config.maxLossUsdt > 0) {
      if (estimatedLoss >= this.config.maxLossUsdt) {
        return {
          triggered: true,
          reason: `絕對金額限損：浮虧 ${estimatedLoss.toFixed(2)} USDT ≥ ${this.config.maxLossUsdt} USDT`,
          estimatedLoss,
        };
      }
    }

    // 條件 B：價格偏離最後層 >= lastLayerDeviationPct%
    const deviationPct = this.config.lastLayerDeviationPct ?? 3;
    let lastLayerDeviation: number;
    if (isLong) {
      lastLayerDeviation = ((lastLayerPrice - currentPrice) / lastLayerPrice) * 100;
    } else {
      lastLayerDeviation = ((currentPrice - lastLayerPrice) / lastLayerPrice) * 100;
    }

    if (lastLayerDeviation >= deviationPct) {
      return {
        triggered: true,
        reason: `條件 B：價格偏離最後層 ${lastLayerDeviation.toFixed(2)}% ≥ ${deviationPct}%`,
        estimatedLoss,
      };
    }

    return { triggered: false, reason: '未觸發', estimatedLoss };
  }

  /**
   * V3.7：硬止損 Max_Loss_Pct
   * 浮虧 % ≥ Max_Loss_Pct → 觸發
   */
  checkHardStopLoss(input: CheckLimitStopInput): CheckLimitStopResult {
    const maxLossPct = this.config.maxLossPct ?? 0;

    if (maxLossPct <= 0) {
      return { triggered: false, reason: '硬止損未啟用', estimatedLoss: 0 };
    }

    const { totalSize, avgPrice, currentPrice, isLong } = input;

    // 計算浮虧百分比（相對於均價）
    let lossPct: number;
    if (isLong) {
      lossPct = ((avgPrice - currentPrice) / avgPrice) * 100;
    } else {
      lossPct = ((currentPrice - avgPrice) / avgPrice) * 100;
    }

    // 盈利時不觸發
    if (lossPct <= 0) {
      return { triggered: false, reason: '未觸發（盈利中）', estimatedLoss: 0 };
    }

    // 計算估算虧損金額
    const totalCost = avgPrice * totalSize;
    const estimatedLoss = totalCost * (lossPct / 100);

    if (lossPct >= maxLossPct) {
      return {
        triggered: true,
        reason: `硬止損觸發：浮虧 ${lossPct.toFixed(2)}% ≥ ${maxLossPct}%`,
        estimatedLoss,
      };
    }

    return { triggered: false, reason: '未觸發', estimatedLoss };
  }

  /**
   * 每日虧損限額檢查
   */
  checkDailyLoss(
    currentDailyLoss: number,
    dailyLimit: number,
  ): { triggered: boolean; reason: string } {
    if (dailyLimit <= 0) {
      return { triggered: false, reason: '每日限額未設定' };
    }
    if (currentDailyLoss >= dailyLimit) {
      return {
        triggered: true,
        reason: `今日虧損 ${currentDailyLoss.toFixed(2)} USDT ≥ 限額 ${dailyLimit.toFixed(2)} USDT`,
      };
    }
    return { triggered: false, reason: '未觸發' };
  }
}

// ============================================================
// 🔥 V4.0 RiskManagerV4（百分比版）
// ============================================================

export interface RiskAlert {
  type: 'LIMIT_STOP' | 'KAMA_REVERSAL' | 'DAILY_LOSS_LIMIT';
  instanceId: string;
  instanceName: string;
  layer: number;
  loss: number;
  lossPct: number;
  reason: string;
}

export class RiskManagerV4 {
  private config: V4Config;
  private dailyLoss: number = 0;
  private dailyResetTime: number = Date.now();

  constructor(config: V4Config) {
    this.config = config;
  }

  checkLimitStop(state: StrategyState, currentPrice: number): { triggered: boolean; reason: string } {
    return shouldTriggerLimitStop(state, currentPrice, this.config);
  }

  checkDailyLossLimit(): { triggered: boolean; reason: string } {
    const now = Date.now();
    if (now - this.dailyResetTime > 24 * 60 * 60 * 1000) {
      this.dailyLoss = 0;
      this.dailyResetTime = now;
    }

    const dailyLimit = this.config.Initial_Capital * 0.03;
    if (this.dailyLoss >= dailyLimit) {
      return {
        triggered: true,
        reason: `今日亏损 ${this.dailyLoss.toFixed(2)} USDT ≥ ${dailyLimit.toFixed(2)} USDT (3% 本金)`,
      };
    }
    return { triggered: false, reason: '未触发' };
  }

  recordLoss(loss: number): void {
    if (loss > 0) {
      this.dailyLoss += loss;
    }
  }

  getStatus(): { dailyLoss: number; dailyLossLimit: number; dailyLossPct: number } {
    const dailyLimit = this.config.Initial_Capital * 0.03;
    return {
      dailyLoss: this.dailyLoss,
      dailyLossLimit: dailyLimit,
      dailyLossPct: (this.dailyLoss / this.config.Initial_Capital) * 100,
    };
  }

  reset(): void {
    this.dailyLoss = 0;
    this.dailyResetTime = Date.now();
  }
}
