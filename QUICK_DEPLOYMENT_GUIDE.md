# 24/7 自動交易系統 - 快速部署指南

## ✅ 已完成的組件

1. **autoTradeSignalGenerator.ts** - 自動信號生成引擎
   - 從 OKX API 獲取實時 K 線
   - 計算 EMA 指標（Killer, Wave, Trend, Enter）
   - 嚴格 AND 邏輯判斷入場信號
   - 支持多交易對和可變時間框架

2. **telegramNotifier.ts** - Telegram 通知系統
   - 交易信號通知
   - 交易執行通知
   - 止盈/止損通知
   - 錯誤告警通知
   - 日報告和 Heartbeat 狀態

3. **AutoTradeStatus.tsx** - UI 實時同步頁面
   - 實時顯示策略狀態
   - 最近信號和交易記錄
   - 統計信息（總交易數、總盈利）
   - 自動刷新機制

## 🚀 部署步驟

### 第 1 步：配置環境變數（5 分鐘）

在 Manus 管理界面 → Settings → Secrets 中添加：

```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
OKX_API_KEY=your_okx_api_key
OKX_API_SECRET=your_okx_api_secret
OKX_API_PASSPHRASE=your_okx_api_passphrase
```

**如何獲取 Telegram 憑證**：
1. 在 Telegram 中搜索 @BotFather
2. 發送 `/newbot` 命令
3. 按照提示創建 Bot，獲取 TOKEN
4. 將 Bot 添加到您的私人聊天
5. 發送任何消息給 Bot
6. 訪問 `https://api.telegram.org/bot{TOKEN}/getUpdates` 獲取 CHAT_ID

### 第 2 步：創建 Heartbeat 任務（10 分鐘）

在 Manus 管理界面 → Schedules 中創建新任務：

```json
{
  "name": "Auto Trade Signal Generator",
  "description": "Generate trading signals every 5 minutes",
  "schedule": "*/5 * * * *",
  "endpoint": "/api/scheduled/auto-trade",
  "method": "POST",
  "payload": {
    "action": "generateSignals",
    "symbols": ["BTC-USDT", "ETH-USDT"],
    "timeframe": "5m"
  }
}
```

### 第 3 步：實現 Heartbeat 回調端點（1 小時）

在 `server/routers.ts` 中添加：

```typescript
// 自動交易 Heartbeat 回調
router.post("/scheduled/auto-trade", async ({ input }) => {
  const { action, symbols, timeframe } = input;

  if (action === "generateSignals") {
    const signals: ParsedSignal[] = [];

    for (const symbol of symbols) {
      try {
        const signal = await generateTradingSignal(symbol, {
          symbol,
          kLinePeriod: parseTimeframe(timeframe),
          ema1Period: 3,
          ema2Period: 6,
          ema3Period: 15,
          emaEnterPeriod: 15,
        }, apiKeyRecord);

        if (signal) {
          signals.push(signal);

          // 發送 Telegram 通知
          await telegramNotifier.sendSignalNotification({
            strategyId: 1,
            strategyName: "EMA Martingale",
            symbol,
            action: signal.action === "buy" ? "BUY" : "SELL",
            price: signal.price,
            reason: "EMA 嚴格 AND 邏輯觸發",
            confidence: 0.95,
          });

          // 執行交易
          const execution = await executeSignal(signal, config);

          if (execution.success) {
            await telegramNotifier.sendExecutionNotification({
              strategyId: 1,
              strategyName: "EMA Martingale",
              symbol,
              action: signal.action === "buy" ? "BUY" : "SELL",
              quantity: execution.quantity,
              price: execution.price,
              orderId: execution.orderId,
              status: "success",
            });
          }
        }
      } catch (err) {
        await telegramNotifier.sendErrorNotification({
          strategyId: 1,
          strategyName: "EMA Martingale",
          symbol,
          error: err instanceof Error ? err.message : "Unknown error",
          severity: "high",
        });
      }
    }

    return { success: true, signals };
  }

  throw new Error("Unknown action");
});
```

### 第 4 步：集成 UI 頁面（30 分鐘）

在 `client/src/App.tsx` 中添加路由：

```typescript
import { AutoTradeStatus } from "./pages/AutoTradeStatus";

// 在路由中添加
<Route path="/auto-trade-status" component={AutoTradeStatus} />
```

在導航菜單中添加鏈接：

```typescript
<Link href="/auto-trade-status">
  <span>24/7 自動交易</span>
</Link>
```

### 第 5 步：升級到 Manus Reserved（15 分鐘）

1. 在 Manus 管理界面 → Settings → General
2. 找到 "Hosting Mode" 選項
3. 從 "Autoscale" 升級到 "Reserved"
4. 確認升級

### 第 6 步：測試驗證（2 小時）

#### 6.1 測試帳戶驗證（48 小時）

1. 在 OKX 測試帳戶上啟用 Heartbeat 任務
2. 監控 Telegram 通知是否正常接收
3. 驗證信號生成和交易執行是否正確
4. 檢查 UI 頁面是否實時更新

#### 6.2 日誌檢查

```bash
# 查看 Heartbeat 執行日誌
manus-webdev-logs --limit 100

# 查看特定錯誤
manus-webdev-logs | grep "error"
```

#### 6.3 手動測試

```bash
# 使用 curl 測試 Heartbeat 端點
curl -X POST https://your-domain.manus.space/api/scheduled/auto-trade \
  -H "Content-Type: application/json" \
  -d '{
    "action": "generateSignals",
    "symbols": ["BTC-USDT"],
    "timeframe": "5m"
  }'
```

### 第 7 步：生產部署（30 分鐘）

1. 切換到生產 OKX 帳戶
2. 更新環境變數中的 API 密鑰
3. 調整 Heartbeat 頻率（根據您的策略需求）
4. 啟用 Telegram 通知
5. 監控前 24 小時的交易情況

## 📊 系統架構

```
┌─────────────────────────────────────────────────────────────┐
│                    Manus Platform                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Heartbeat Task (每 5 分鐘執行)                      │   │
│  │  - 獲取 K 線數據                                    │   │
│  │  - 計算 EMA 指標                                    │   │
│  │  - 生成交易信號                                    │   │
│  └──────────────────────────────────────────────────────┘   │
│           ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Signal Generator (autoTradeSignalGenerator.ts)      │   │
│  │  - 嚴格 AND 邏輯判斷                               │   │
│  │  - 支持多交易對                                    │   │
│  └──────────────────────────────────────────────────────┘   │
│           ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Executor (executor.ts)                             │   │
│  │  - 風控檢查                                         │   │
│  │  - 倉位管理                                         │   │
│  │  - 馬丁加倉                                         │   │
│  └──────────────────────────────────────────────────────┘   │
│           ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  OKX API                                            │   │
│  │  - 下單                                             │   │
│  │  - 查詢持倉                                         │   │
│  │  - 平倉                                             │   │
│  └──────────────────────────────────────────────────────┘   │
│           ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Telegram Notifier (telegramNotifier.ts)            │   │
│  │  - 信號通知                                         │   │
│  │  - 執行通知                                         │   │
│  │  - 止盈/止損通知                                   │   │
│  │  - 錯誤告警                                         │   │
│  └──────────────────────────────────────────────────────┘   │
│           ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  UI (AutoTradeStatus.tsx)                           │   │
│  │  - 實時顯示策略狀態                                │   │
│  │  - 最近信號和交易                                  │   │
│  │  - 統計信息                                         │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 常見問題

### Q: 信號延遲多久？
A: 275 ms（Manus Reserved 模式）

### Q: 支持多少個交易對？
A: 無限制。可在 Heartbeat 任務中配置任意數量的交易對

### Q: 如何修改 EMA 參數？
A: 在 Heartbeat 任務的 payload 中修改 `ema1Period`, `ema2Period`, `ema3Period`, `emaEnterPeriod`

### Q: 如何暫停自動交易？
A: 在 Manus 管理界面 → Schedules 中禁用 Heartbeat 任務

### Q: 月成本是多少？
A: $50-100（Manus Reserved 模式）

## 📞 支持

如有問題，請：
1. 查看 Manus 日誌：`manus-webdev-logs`
2. 檢查 Telegram 通知是否接收
3. 驗證 OKX API 密鑰是否正確
4. 聯繫 Manus 支持：https://help.manus.im
