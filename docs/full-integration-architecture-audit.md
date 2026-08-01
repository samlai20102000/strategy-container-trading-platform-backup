# 策略、回測、快照與 S1／M2／H3 完全集成架構稽核

## 稽核結論

現有系統並非缺少三模式核心能力，而是**資料契約已存在、使用者工作流未接通**。回測 API 與引擎已接受 `executionMode`、`executionPolicy`、策略版本、邏輯雜湊及 capability manifest；參數快照後端亦已能保存 `EXECUTION_PROFILE` artifact；部署後端則具備 DRAFT、PREFLIGHT_FAILED、READY_DISABLED、ACTIVE、PAUSED、DRAINING、BLOCKED 與 ARCHIVED 的安全狀態機。

目前失效感主要來自四個 UI／交接缺口：

1. 回測頁沒有暴露 S1／M2／H3 與 policy，提交及保存快照時也沒有傳送 execution profile。
2. 參數快照庫只展示 artifact 中繼資料，沒有把模式配置作為可見、可比較、可建立部署的第一級內容。
3. 策略交易卡對 canonical deployment 刻意只提供「部署工作台」連結，沒有卡內模式選擇、預檢結果與下一步操作。
4. 部署草稿建立後保持 DRAFT；Preflight 只會把它推進 READY_DISABLED，只有另一次 `activate` 才會 ACTIVE。現有按鈕依狀態動態出現，導致使用者看不出「建立 → 預檢 → 啟用」三步鏈。

## 必須重用的現有能力

| 能力 | 現有唯一真相來源 | 本輪做法 |
|---|---|---|
| S1／M2／H3 型別與安全不變式 | `shared/executionModes.ts` | 不另建模式型別；所有頁面共用正規化政策 |
| KRM H3 4% 契約 | `shared/strategies/kamaRainbowMartinExecutionPolicy.ts` | 沿用策略感知 policy helper |
| 回測模式執行與 modeResults | `server/services/backtest/*` | 只補 UI 及 artifact 接線，不重寫引擎 |
| 完整快照 artifact | `server/services/strategyArtifacts.ts`、`server/routers/backtest.router.ts` | 直接保存 `EXECUTION_PROFILE` |
| 部署狀態機與 Preflight | `server/services/deploymentLifecycle*.ts` | 不放寬 Gate；改善步驟式操作與 blocker 修復入口 |
| 部署 CRUD／模式切換 | `server/routers/deployments.router.ts` | 擴充建立來源及快速啟動 orchestration，不平行重做 API |
| 策略 CRUD 與現有表單 | `client/src/pages/Strategies.tsx` | 加入模式與部署控制區，保留原參數編輯器 |
| 部署清單、Policy、Preflight、歷史 | `client/src/pages/DeploymentWorkbench.tsx` | 重排為「快速啟動／部署管理」雙工作區 |

## Canonical 資料流

`Strategy definition/instance → BacktestRequest + ExecutionPolicy → BacktestResult.modeResults → EXECUTION_PROFILE Snapshot → Strategy import/update → Deployment DRAFT → readonly Preflight → READY_DISABLED → explicit Activate → ACTIVE → CandidateIntent → ModeDecision → Order`

每一個下單決策必須以 `deploymentId + deploymentRevision + sealed strategy artifact + executionPolicyHash` 解析，不接受瀏覽器臨時 payload 直接指定實盤模式。模式切換維持 flat／drained Gate；建立、複製、快照導入與切換皆預設停用。

## Hosting 與排程邊界

目前 Autoscale 環境不能可靠承載 15 秒或 1 分鐘的常駐輪詢。UI、資料契約、Heartbeat 任務及按請求執行可在本輪完成；真正 24/7 子分鐘實盤掃描必須使用持續運行主機／Reserved 類型環境，否則只保留 webhook、明確手動觸發或受管理排程入口。生產驗證不得送出真實訂單，只能使用單元測試、mock exchange 或 testnet。

## 最小改動順序

1. 抽取共享模式選擇／policy 編輯 UI，接入回測。
2. 讓回測保存完整 execution profile，快照庫可見且可轉為策略／部署草稿。
3. 在策略卡加入卡內模式草稿、預檢與啟用導引，仍由 canonical lifecycle API 執行。
4. 將部署工作台重排為快速啟動與管理，顯示固定三步進度及 blocker 修復入口。
5. 確認自動、webhook 與手動信號均從 deployment sealed artifact 讀取模式，並修復 OKX adapter 契約測試。

