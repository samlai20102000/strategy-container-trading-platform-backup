# 24/7 自動交易系統完整實施指南

## 系統架構概覽

```
Manus Heartbeat (每 5 分鐘)
    ↓
自動交易信號生成引擎 (autoTradeSignalGenerator.ts)
    ↓ 獲取 K 線數據 + 計算 EMA + 判斷信號
ParsedSignal (買入/賣出/平倉)
    ↓
交易執行器 (executor.ts)
    ↓ 風控檢查 + 倉位管理 + 下單
OKX 交易所
    ↓ 交易結果
Telegram 通知 + UI 同步
```

---

## 第 1 部分：Heartbeat 任務 API 端點

### 1.1 創建 API 路由

在 `server/routers.ts` 中添加以下路由：

```typescript
// 創建自動交易 Heartbeat 任務
export const autoTradeRouter = router({
  // 為策略創建 Heartbeat 任務
  setupHeartbeat: protectedProcedure
    .input(z.object({
      strategyId: z.number(),
      symbols: z.array(z.string()),
      kLinePeriod: z.number(), // 5, 15, 60, 240
    }))
    .mutation(async ({ input, ctx }) => {
      const strategy = await getStrategyById(input.strategyId);
      if (!strategy) throw new TRPCError({ code: "NOT_FOUND" });
      
      const results = await setupHeartbeatForMultipleSymbols(
        input.strategyId,
        input.symbols,
        input.kLinePeriod,
        ctx.userSession || ""
      );
      
      return results;
    }),

  // 停用 Heartbeat 任務
  disableHeartbeat: protectedProcedure
    .input(z.object({ taskUid: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await disableHeartbeatForStrategy(input.taskUid, ctx.userSession || "");
      return { success: true };
    }),

  // 列出所有 Heartbeat 任務
  listHeartbeatTasks: protectedProcedure
    .query(async ({ ctx }) => {
      return await listHeartbeatTasks(ctx.userSession || "");
    }),
});
```

### 1.2 Heartbeat 回調端點

在 `server/routers.ts` 中添加 Heartbeat 回調端點：

```typescript
// 系統路由中添加
export const systemRouter = router({
  // ... 現有路由 ...
  
  // Heartbeat 回調：自動交易信號生成和執行
  autoTrade: publicProcedure
    .input(z.object({
      strategyId: z.number(),
      symbol: z.string(),
      kLinePeriod: z.number(),
    }))
    .mutation(async ({ input }) => {
      try {
        // 1. 獲取策略配置
        const strategy = await getStrategyById(input.strategyId);
        if (!strategy) {
          return { status: "failed", message: "Strategy not found" };
        }
        
        // 2. 獲取 API 密鑰
        const apiKeyRecord = await getApiKeyById(strategy.apiKeyId);
        if (!apiKeyRecord) {
          return { status: "failed", message: "API key not found" };
        }
        
        // 3. 生成交易信號
        const signal = await generateTradingSignal(input.symbol, {
          symbol: input.symbol,
          kLinePeriod: input.kLinePeriod,
          ema1Period: parseInt(strategy.config?.EMA1_Period || "3"),
          ema2Period: parseInt(strategy.config?.EMA2_Period || "6"),
          ema3Period: parseInt(strategy.config?.EMA3_Period || "15"),
          emaEnterPeriod: parseInt(strategy.config?.TimeFrameEnter || "15"),
        }, apiKeyRecord);
        
        if (!signal) {
          return { status: "skipped", message: "No trading signal generated" };
        }
        
        // 4. 創建信號記錄
        const signalId = await createSignal({
          strategyId: strategy.id,
          userId: strategy.userId,
          action: signal.action,
          symbol: signal.symbol,
          price: signal.price,
          source: "heartbeat",
        });
        
        // 5. 執行交易
        const executionResult = await executeSignal(strategy, signal, signalId);
        
        // 6. 發送 Telegram 通知
        await sendTelegramNotification({
          strategyId: strategy.id,
          message: `Signal: ${signal.action.toUpperCase()} ${signal.symbol} @ ${signal.price}`,
          result: executionResult,
        });
        
        return executionResult;
      } catch (error) {
        console.error("[AutoTrade] Error:", error);
        return { status: "failed", message: String(error) };
      }
    }),
});
```

---

## 第 2 部分：Telegram 通知系統

### 2.1 Telegram 通知服務

創建 `server/services/telegramNotifier.ts`：

```typescript
import { ENV } from "../_core/env";

export interface TelegramNotification {
  strategyId: number;
  message: string;
  result?: any;
  priority?: "low" | "normal" | "high";
}

/**
 * 發送 Telegram 通知
 */
export async function sendTelegramNotification(
  notification: TelegramNotification
): Promise<boolean> {
  try {
    // 從環境變數獲取 Telegram Bot Token 和 Chat ID
    const botToken = ENV.telegramBotToken;
    const chatId = ENV.telegramChatId;
    
    if (!botToken || !chatId) {
      console.warn("[TelegramNotifier] Telegram credentials not configured");
      return false;
    }
    
    // 格式化消息
    let text = `🤖 *自動交易系統通知*\n`;
    text += `策略 ID: ${notification.strategyId}\n`;
    text += `時間: ${new Date().toISOString()}\n`;
    text += `\n${notification.message}\n`;
    
    if (notification.result) {
      text += `\n狀態: ${notification.result.status}\n`;
      if (notification.result.orderId) {
        text += `訂單 ID: ${notification.result.orderId}\n`;
      }
    }
    
    // 發送 Telegram 消息
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      }
    );
    
    return response.ok;
  } catch (error) {
    console.error("[TelegramNotifier] Error sending notification:", error);
    return false;
  }
}

/**
 * 發送關鍵事件告警
 */
export async function sendCriticalAlert(
  strategyId: number,
  alertType: string,
  details: string
): Promise<boolean> {
  const message = `🚨 *關鍵告警*\n類型: ${alertType}\n詳情: ${details}`;
  return sendTelegramNotification({
    strategyId,
    message,
    priority: "high",
  });
}
```

### 2.2 環境變數配置

在 `server/_core/env.ts` 中添加：

```typescript
export const ENV = {
  // ... 現有環境變數 ...
  
  // Telegram 配置
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};
```

---

## 第 3 部分：UI 同步優化

### 3.1 前端 Heartbeat 狀態顯示

在 `client/src/pages/Strategies.tsx` 中添加：

```typescript
// 顯示 Heartbeat 任務狀態
function HeartbeatStatus({ strategy }: { strategy: Strategy }) {
  const [heartbeatTasks, setHeartbeatTasks] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  
  useEffect(() => {
    const fetchHeartbeatStatus = async () => {
      setIsLoading(true);
      try {
        const tasks = await trpc.autoTrade.listHeartbeatTasks.query();
        const relevantTasks = tasks.filter(t => 
          t.description.includes(strategy.id.toString())
        );
        setHeartbeatTasks(relevantTasks);
      } catch (error) {
        console.error("Failed to fetch Heartbeat status:", error);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchHeartbeatStatus();
    // 每 30 秒刷新一次
    const interval = setInterval(fetchHeartbeatStatus, 30000);
    return () => clearInterval(interval);
  }, [strategy.id]);
  
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">Heartbeat 任務狀態</h3>
      {isLoading ? (
        <Spinner />
      ) : heartbeatTasks.length === 0 ? (
        <p className="text-sm text-gray-500">無 Heartbeat 任務</p>
      ) : (
        <div className="space-y-1">
          {heartbeatTasks.map(task => (
            <div key={task.taskUid} className="text-sm">
              <span className={task.isEnable ? "text-green-600" : "text-gray-500"}>
                {task.isEnable ? "✓" : "✗"} {task.description}
              </span>
              <span className="text-xs text-gray-400 ml-2">
                下次執行: {new Date(task.nextExecutionAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### 3.2 實時交易狀態面板

在 `client/src/pages/Strategies.tsx` 中添加：

```typescript
// 實時交易狀態
function LiveTradeStatus({ strategyId }: { strategyId: number }) {
  const [trades, setTrades] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  
  useEffect(() => {
    const fetchTradeStatus = async () => {
      try {
        // 獲取最近的交易記錄
        const recentTrades = await trpc.trades.list.query({
          strategyId,
          limit: 10,
        });
        setTrades(recentTrades);
        
        // 計算統計信息
        const stats = {
          totalTrades: recentTrades.length,
          winRate: recentTrades.filter(t => t.pnl > 0).length / recentTrades.length,
          totalPnl: recentTrades.reduce((sum, t) => sum + (t.pnl || 0), 0),
        };
        setStats(stats);
      } catch (error) {
        console.error("Failed to fetch trade status:", error);
      }
    };
    
    fetchTradeStatus();
    // 每 10 秒刷新一次
    const interval = setInterval(fetchTradeStatus, 10000);
    return () => clearInterval(interval);
  }, [strategyId]);
  
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent>
            <p className="text-sm text-gray-600">總交易數</p>
            <p className="text-2xl font-bold">{stats?.totalTrades || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-gray-600">勝率</p>
            <p className="text-2xl font-bold">
              {((stats?.winRate || 0) * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-gray-600">總盈虧</p>
            <p className={`text-2xl font-bold ${(stats?.totalPnl || 0) > 0 ? "text-green-600" : "text-red-600"}`}>
              ${(stats?.totalPnl || 0).toFixed(2)}
            </p>
          </CardContent>
        </Card>
      </div>
      
      <div>
        <h3 className="font-semibold mb-2">最近交易</h3>
        <div className="space-y-1">
          {trades.map(trade => (
            <div key={trade.id} className="text-sm flex justify-between">
              <span>{trade.side.toUpperCase()} {trade.symbol}</span>
              <span className={trade.pnl > 0 ? "text-green-600" : "text-red-600"}>
                ${trade.pnl?.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

## 第 4 部分：完整的測試計劃

### 4.1 測試帳戶驗證（48 小時）

**第 1-8 小時：功能驗證**
- [ ] Heartbeat 任務每 5 分鐘準時執行
- [ ] K 線數據正確獲取
- [ ] EMA 指標正確計算
- [ ] 信號生成邏輯正確（嚴格 AND）
- [ ] 交易執行成功（測試帳戶）
- [ ] 風控機制正確觸發
- [ ] Telegram 通知實時發送
- [ ] UI 實時更新

**第 9-24 小時：穩定性測試**
- [ ] 連續運行無異常
- [ ] 多交易對同時交易無衝突
- [ ] 馬丁加倉正確執行
- [ ] 止盈/止損準確觸發

**第 25-48 小時：壓力測試**
- [ ] 快速市場波動時的信號準確性
- [ ] 高頻交易對（如 BTC）的性能
- [ ] 系統故障恢復能力

### 4.2 測試檢查清單

```
[ ] Heartbeat 任務創建成功
[ ] 信號生成延遲 < 100 ms
[ ] 交易執行成功率 > 99%
[ ] Telegram 通知無延遲
[ ] UI 實時顯示準確
[ ] 多交易對獨立運行
[ ] 馬丁層數正確計算
[ ] 風控參數生效
[ ] 數據庫記錄完整
[ ] 日誌輸出正常
```

---

## 第 5 部分：部署清單

### 5.1 部署前檢查

- [ ] 升級 Manus 到 Reserved 模式
- [ ] 配置 Telegram Bot Token 和 Chat ID
- [ ] 驗證 OKX API 密鑰有效性
- [ ] 確認所有環境變數已設置
- [ ] 測試帳戶驗證通過
- [ ] 備份數據庫

### 5.2 上線步驟

1. **第 1 步**：在 Manus 管理界面升級到 Reserved 模式
2. **第 2 步**：部署代碼（自動發布）
3. **第 3 步**：創建 Heartbeat 任務
4. **第 4 步**：監控前 24 小時
5. **第 5 步**：逐步增加交易對數量

---

## 成功指標

系統正常運行的標誌：

| 指標 | 目標 | 驗證方法 |
|------|------|--------|
| Heartbeat 執行率 | 100% | 檢查 Manus 日誌 |
| 信號延遲 | < 100 ms | 檢查時間戳差異 |
| 交易執行率 | > 99% | 檢查交易記錄 |
| Telegram 通知 | 實時 | 檢查通知時間 |
| UI 同步延遲 | < 2 秒 | 檢查頁面更新 |
| 系統可用性 | > 99.9% | 檢查運行時間 |

---

## 故障排查

### 問題 1：Heartbeat 任務未執行

**原因**：
- Manus Autoscale 模式冷啟動延遲
- Heartbeat 任務配置錯誤

**解決方案**：
- 升級到 Reserved 模式
- 檢查 Cron 表達式格式

### 問題 2：信號延遲過高

**原因**：
- OKX API 響應慢
- 計算 EMA 耗時過長

**解決方案**：
- 增加 K 線數據緩存
- 優化 EMA 計算算法

### 問題 3：交易執行失敗

**原因**：
- API 密鑰無效
- 倉位超限
- 交易對不支持

**解決方案**：
- 驗證 API 密鑰
- 檢查風控參數
- 確認交易對有效性

---

## 下一步

1. **立即執行**：升級到 Reserved 模式
2. **部署代碼**：將上述代碼集成到項目
3. **配置環境**：設置 Telegram 和 OKX API
4. **測試驗證**：在測試帳戶運行 48 小時
5. **上線交易**：切換到實盤帳戶

預計總耗時：**6-8 小時代碼開發 + 48 小時測試 + 24 小時監控**
