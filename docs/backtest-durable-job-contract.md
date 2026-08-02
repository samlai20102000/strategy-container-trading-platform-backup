# 全策略 Durable Backtest Job Contract

## 1. 事故根因與修復邊界

本契約針對 `jobId=360010` 的 Kama 彩虹馬丁 M2 回測事故建立。該工作共有 27,744 根 K 線，最後持久化於 10,000 根（56%），容器內 active controller 已不存在，但資料庫仍標記為 `running`。事故不是 M2 認證問題，也不是 10,000 根資料上限，而是三層缺口疊加：Kama 彩虹馬丁每棒多次複製並重算全部歷史造成 O(n²)；Autoscale 容器終止後記憶體 Map 執行器消失；資料庫沒有 lease、heartbeat、持久化取消與 stale recovery 契約。

修復不得改變任何策略的入場、加倉、出場、風控或 S1／M2／H3 業務語意，亦不得呼叫任何交易所送單、撤單或平倉 API。所有現有與未來策略 runner 必須只透過同一工作控制介面回報進度、檢查取消及保存終態。

## 2. 資料庫狀態機

`backtest_jobs` 新增以下欄位，時間一律為 UTC Unix milliseconds：

| 欄位 | 用途 | 不變量 |
|---|---|---|
| `phase` | `QUEUED`、`PREPARING`、`RUNNING`、`FINALIZING`、`COMPLETED`、`FAILED`、`CANCELLED` | 終態不可逆轉 |
| `processedBars` | 已完成的可回報 K 棒數 | 單調遞增且不大於 `totalBars` |
| `totalBars` | 本次工作總 K 棒數 | 載入資料後固定 |
| `heartbeatAt` | worker 最後成功保存心跳 | active lease 期間必須更新 |
| `leaseToken` | 單一 worker 的不可猜測 UUID | 更新工作時必須比對 |
| `leaseExpiresAt` | lease 到期時間 | 只有過期 lease 可被另一 worker 接管 |
| `cancelRequested` | 使用者持久化取消意圖 | 一旦為 true 不得重設 |
| `attemptCount` | worker 接管／重試次數 | 單調遞增 |
| `startedAt` | 首次真正開始時間 | 首次寫入後固定 |
| `finishedAt` | 終態保存時間 | 只在終態寫入 |
| `errorCode` | 穩定、可機器判讀的錯誤碼 | failed／stale 終態必填 |

狀態轉移只允許：`pending → running → completed|failed|cancelled`。UI 使用 `phase` 顯示細階段，但不得自行改寫主狀態。結果寫入與 `completed` 終態必須在同一資料庫交易內完成，禁止出現「completed 無結果」。

## 3. Lease 與 Stale 規則

worker 以條件更新取得 lease：工作必須尚未終結、`cancelRequested=false`，且既有 lease 為空、已過期或屬於同一 token。每次 checkpoint 同時更新 `heartbeatAt`、`leaseExpiresAt`、`processedBars`、`progress`、`phase`；所有更新必須帶 `jobId + userId + leaseToken` 條件，失去 lease 的 worker 立即停止，不得覆蓋新 owner。

| 常數 | 初始值 | 理由 |
|---|---:|---|
| Slice budget | 35 秒 | 低於 Heartbeat 45 秒建議上限並預留保存時間 |
| Lease TTL | 90 秒 | 可跨一次暫時延遲，同時能快速接管 |
| Checkpoint bars | 250 根 | 讓 30m 大型資料集有可見進度且取消延遲可控 |
| Checkpoint time | 2 秒 | 即使單棒很慢亦能更新心跳 |
| UI stale warning | 120 秒 | 超過 lease TTL 後顯示恢復中／中斷，不再假裝正常運行 |
| Maximum attempts | 3 | 避免永久重試；超限寫入 `BACKTEST_RETRY_EXHAUSTED` |

stale watchdog 不得僅在前端判斷。scheduled worker 每次先掃描 `running` 且 lease 過期的工作，嘗試接管；若工作不具可續跑 checkpoint，必須明確失敗為 `BACKTEST_WORKER_INTERRUPTED`，而不是永久保留 `running`。第一版以「確定性重新執行整個純回測」恢復，使用相同 request snapshot／logic hash，結果仍只寫一次；後續可在不改契約下加入完整 kernel checkpoint。

## 4. JobControl 共用介面

所有 runner 接受同一 `BacktestJobControl`，禁止策略自行直接更新 `backtest_jobs`：

```ts
interface BacktestJobControl {
  readonly signal: AbortSignal;
  checkpoint(input: {
    phase: BacktestJobPhase;
    processedBars: number;
    totalBars: number;
    message: string;
    force?: boolean;
  }): Promise<void>;
  throwIfCancelled(): Promise<void>;
  shouldYield(): boolean;
}
```

`BacktestEngine.runBacktest()`、傳統 S1 runner 與三模式 portfolio runner 都只使用此介面。`AbortSignal` 處理同一容器內的立即取消；`cancelRequested` 是跨容器真相。checkpoint 會查詢持久化取消旗標並在需要時 abort。任何策略新增時只需實作策略 evaluator，不得另建背景 Map、進度表或自有 heartbeat。

## 5. 指標與歷史資料效能契約

`PortfolioAdapterBarContext` 不再暴露可任意全量複製的 `candles`。它改為提供當前棒、索引、O(1) 的 `previousCandle(offset)` 及 factory 初始化時建立的策略專屬預計算序列。adapter 的 `evaluateBar` 內禁止 `slice(0, index)`、`map` 全歷史、重新計算完整 KAMA／MA／ATR 序列或任何隨 index 成長的掃描。

Kama 彩虹馬丁在 factory 初始化時：驗證 canonical config 一次；為每條啟用 KAMA 線各計算一次完整 causal series；按 index 建立 O(1) snapshot view。逐棒 evaluator 只取該 index 的 previous／current 值，再沿用原有 touch、cross、slope、direction 與 Bar-Lock 決策。等價測試必須逐棒比較舊演算法與預計算演算法的 snapshot、reasonCode、action、price 與 timestamp。

其他仍依賴陣列型 legacy evaluator 的內建策略，必須在 factory 初始化時改成一次性指標序列或明確固定上限 ring window；不得以共用 `closedCandles()` 恢復無界複製。架構守門測試會掃描所有 portfolio adapter，阻擋 `context.candles`、`closedCandles()` 與 `slice(0, context.index...)` 回歸。

## 6. Scheduled Worker

使用平台 Heartbeat 建立每分鐘 callback，路徑固定為 `/api/scheduled/backtest-worker`。handler 必須經現有 cron 身份驗證，並以 `taskUid` 對應工作／擁有者；不得接受普通瀏覽器或匿名請求。每次 callback 最多執行一個 35 秒 slice，結束前釋放或延長 lease並回傳目前 phase／processed／total。

建立工作時保存完整且不可變的回測 request snapshot、strategy artifact／logic hash 及 owner。排程建立失敗時，工作不得假裝可恢復；應立即保存 `BACKTEST_SCHEDULE_CREATE_FAILED`。工作進入終態後刪除對應 Heartbeat task；刪除失敗只記錄清理錯誤，不得改寫已完成結果。

## 7. UI 契約

進度面板顯示 `phase`、`processedBars / totalBars`、百分比、開始時間、最後心跳、經過時間與恢復狀態。`heartbeatAt` 超過 120 秒時：若 lease 已過期且 attempt 尚可用，顯示「工作中斷，系統正在嘗試恢復」；若後端回傳明確 failed，顯示 errorCode、可理解訊息與「重新提交」。UI 不得只因 stale 自行把工作寫成 failed，也不得永久顯示舊百分比為正常 running。

取消按鈕先把 `cancelRequested=true` 寫入資料庫，再 best-effort abort 本地 controller。成功語意是「取消要求已持久化」；worker 在下一 checkpoint 原子寫入 `cancelled`。重複取消具冪等性。

## 8. 驗收閘門

交付前必須通過：27,744 根 Kama 彩虹馬丁 M2 確定性 benchmark；S1／M2／H3 與全部內建策略 smoke；逐棒等價測試；取消延遲；lease 競爭；容器重啟／stale 接管；最大重試；錯誤與結果原子化；未來 adapter 架構守門；完整 Vitest、TypeScript、production build、桌面與手機 UI；交易所 mutation 後驗為零。

