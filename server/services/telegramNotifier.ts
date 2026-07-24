/**
 * Telegram 通知系統
 * 發送交易信號、執行結果和告警通知
 */

import axios from "axios";

interface TelegramNotificationParams {
  strategyId?: number;
  strategyName?: string;
  symbol?: string;
  message: string;
  type?: "signal" | "error" | "alert" | "success";
  metadata?: Record<string, any>;
}

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private isConfigured: boolean;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    this.chatId = process.env.TELEGRAM_CHAT_ID || "";
    this.isConfigured = !!this.botToken && !!this.chatId;

    if (!this.isConfigured) {
      console.warn(
        "[TelegramNotifier] Telegram credentials not configured. Notifications will be skipped."
      );
    }
  }

  /**
   * 發送通知
   */
  async send(params: TelegramNotificationParams): Promise<boolean> {
    if (!this.isConfigured) {
      console.warn("[TelegramNotifier] Telegram not configured, skipping notification");
      return false;
    }

    try {
      const emoji = this.getEmoji(params.type);
      const formattedMessage = this.formatMessage(emoji, params);

      const response = await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: this.chatId,
          text: formattedMessage,
          parse_mode: "HTML",
        },
        { timeout: 5000 }
      );

      if (response.status === 200) {
        console.log(
          `[TelegramNotifier] Notification sent: ${params.symbol} ${params.type}`
        );
        return true;
      }

      return false;
    } catch (err) {
      console.error("[TelegramNotifier] Error sending notification:", err);
      return false;
    }
  }

  /**
   * 發送交易信號通知
   */
  async sendSignalNotification(params: {
    strategyId: number;
    strategyName: string;
    symbol: string;
    action: "BUY" | "SELL";
    price: number;
    reason: string;
    confidence: number;
  }): Promise<boolean> {
    const message = `
<b>🚀 交易信號</b>

<b>策略：</b> ${params.strategyName}
<b>交易對：</b> ${params.symbol}
<b>方向：</b> <b>${params.action === "BUY" ? "🟢 做多" : "🔴 做空"}</b>
<b>價格：</b> $${params.price.toFixed(2)}
<b>信心度：</b> ${(params.confidence * 100).toFixed(0)}%
<b>理由：</b> ${params.reason}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      strategyId: params.strategyId,
      strategyName: params.strategyName,
      symbol: params.symbol,
      message,
      type: "signal",
    });
  }

  /**
   * 發送交易執行通知
   */
  async sendExecutionNotification(params: {
    strategyId: number;
    strategyName: string;
    symbol: string;
    action: "BUY" | "SELL";
    quantity: number;
    price: number;
    orderId: string;
    status: "success" | "failed";
  }): Promise<boolean> {
    const statusEmoji = params.status === "success" ? "✅" : "❌";
    const message = `
<b>${statusEmoji} 交易執行</b>

<b>策略：</b> ${params.strategyName}
<b>交易對：</b> ${params.symbol}
<b>方向：</b> ${params.action === "BUY" ? "🟢 做多" : "🔴 做空"}
<b>數量：</b> ${params.quantity.toFixed(4)}
<b>價格：</b> $${params.price.toFixed(2)}
<b>訂單 ID：</b> <code>${params.orderId}</code>
<b>狀態：</b> ${params.status === "success" ? "成功" : "失敗"}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      strategyId: params.strategyId,
      strategyName: params.strategyName,
      symbol: params.symbol,
      message,
      type: params.status === "success" ? "success" : "error",
    });
  }

  /**
   * 發送止盈通知
   */
  async sendTakeProfitNotification(params: {
    strategyId: number;
    strategyName: string;
    symbol: string;
    profit: number;
    profitPct: number;
    closePrice: number;
  }): Promise<boolean> {
    const message = `
<b>💰 止盈</b>

<b>策略：</b> ${params.strategyName}
<b>交易對：</b> ${params.symbol}
<b>盈利：</b> $${params.profit.toFixed(2)} (${(params.profitPct * 100).toFixed(2)}%)
<b>平倉價：</b> $${params.closePrice.toFixed(2)}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      strategyId: params.strategyId,
      strategyName: params.strategyName,
      symbol: params.symbol,
      message,
      type: "success",
    });
  }

  /**
   * 發送止損通知
   */
  async sendStopLossNotification(params: {
    strategyId: number;
    strategyName: string;
    symbol: string;
    loss: number;
    lossPct: number;
    closePrice: number;
  }): Promise<boolean> {
    const message = `
<b>⛔ 止損</b>

<b>策略：</b> ${params.strategyName}
<b>交易對：</b> ${params.symbol}
<b>虧損：</b> $${params.loss.toFixed(2)} (${(params.lossPct * 100).toFixed(2)}%)
<b>平倉價：</b> $${params.closePrice.toFixed(2)}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      strategyId: params.strategyId,
      strategyName: params.strategyName,
      symbol: params.symbol,
      message,
      type: "alert",
    });
  }

  /**
   * 發送錯誤通知
   */
  async sendErrorNotification(params: {
    strategyId: number;
    strategyName: string;
    symbol?: string;
    error: string;
    severity?: "low" | "medium" | "high";
  }): Promise<boolean> {
    const severityEmoji = {
      low: "⚠️",
      medium: "⚠️⚠️",
      high: "🚨",
    }[params.severity || "medium"];

    const message = `
<b>${severityEmoji} 錯誤通知</b>

<b>策略：</b> ${params.strategyName}
${params.symbol ? `<b>交易對：</b> ${params.symbol}\n` : ""}
<b>錯誤：</b> ${params.error}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      strategyId: params.strategyId,
      strategyName: params.strategyName,
      symbol: params.symbol,
      message,
      type: "error",
      metadata: { severity: params.severity },
    });
  }

  /**
   * 發送手動平倉通知
   */
  async sendClosePositionNotification(params: {
    strategyId: number;
    strategyName: string;
    symbol: string;
    success: boolean;
    closedSides: string[];
    errorMessage?: string;
    paused?: boolean;
  }): Promise<boolean> {
    const statusEmoji = params.success ? "✅" : "❌";
    const directionText = params.closedSides.length > 0
      ? params.closedSides.map(s => s === "long" ? "🟢 多" : s === "short" ? "🔴 空" : s).join(" + ")
      : "未知方向";
    const message = `
<b>${statusEmoji} 手動平倉</b>

<b>策略：</b> ${params.strategyName}
<b>交易對：</b> ${params.symbol}
<b>方向：</b> ${directionText}
<b>結果：</b> ${params.success ? "平倉成功" : `平倉失敗 - ${params.errorMessage || "未知錯誤"}`}${params.paused ? "\n<b>狀態：</b> 策略已自動暫停" : ""}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      strategyId: params.strategyId,
      strategyName: params.strategyName,
      symbol: params.symbol,
      message,
      type: params.success ? "success" : "error",
    });
  }

  /**
   * 發送緊急全平倉彙總通知
   */
  async sendEmergencyCloseAllNotification(params: {
    successCount: number;
    failCount: number;
    skippedCount: number;
    results: { strategyId: number; name: string; symbol: string; success: boolean; message: string }[];
  }): Promise<boolean> {
    const emoji = params.failCount === 0 ? "✅" : "⚠️";
    const detailLines = params.results
      .filter(r => r.message !== "無持倉，跳過")
      .slice(0, 10)
      .map(r => `  ${r.success ? "✅" : "❌"} ${r.name} (${r.symbol}): ${r.message}`)
      .join("\n");
    const message = `
<b>${emoji} 緊急全平倉</b>

<b>平倉成功：</b> ${params.successCount}
<b>平倉失敗：</b> ${params.failCount}
<b>無持倉跳過：</b> ${params.skippedCount}
<b>全部策略已暫停</b>
${detailLines ? `\n<b>詳情：</b>\n<code>${detailLines}</code>` : ""}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      message,
      type: params.failCount > 0 ? "alert" : "success",
    });
  }

  /**
   * 發送日報告
   */
  async sendDailyReport(params: {
    date: string;
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    totalProfit: number;
    winRate: number;
  }): Promise<boolean> {
    const message = `
<b>📊 每日交易報告</b>

<b>日期：</b> ${params.date}
<b>總交易數：</b> ${params.totalTrades}
<b>贏利交易：</b> ${params.winTrades}
<b>虧損交易：</b> ${params.lossTrades}
<b>勝率：</b> ${(params.winRate * 100).toFixed(2)}%
<b>總盈利：</b> $${params.totalProfit.toFixed(2)}
<b>時間：</b> ${new Date().toLocaleString("zh-CN")}
    `.trim();

    return this.send({
      message,
      type: "success",
    });
  }

  /**
   * 發送 Heartbeat 狀態
   */
  async sendHeartbeatStatus(params: {
    timestamp: string;
    strategiesProcessed: number;
    signalsGenerated: number;
    tradesExecuted: number;
    errors: number;
  }): Promise<boolean> {
    const message = `
<b>💓 Heartbeat 狀態</b>

<b>時間：</b> ${params.timestamp}
<b>處理策略：</b> ${params.strategiesProcessed}
<b>生成信號：</b> ${params.signalsGenerated}
<b>執行交易：</b> ${params.tradesExecuted}
<b>錯誤數：</b> ${params.errors}
    `.trim();

    return this.send({
      message,
      type: params.errors > 0 ? "alert" : "success",
    });
  }

  /**
   * 獲取 emoji
   */
  private getEmoji(type?: string): string {
    const emojiMap: Record<string, string> = {
      signal: "🚀",
      error: "❌",
      alert: "⚠️",
      success: "✅",
    };

    return emojiMap[type || "signal"];
  }

  /**
   * 格式化消息
   */
  private formatMessage(emoji: string, params: TelegramNotificationParams): string {
    if (params.message.includes("<b>")) {
      // 已格式化的消息
      return params.message;
    }

    // 簡單消息格式化
    return `${emoji} ${params.message}`;
  }
}

export const telegramNotifier = new TelegramNotifier();
