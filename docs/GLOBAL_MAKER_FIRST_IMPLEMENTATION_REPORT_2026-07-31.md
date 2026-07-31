# 全系統 Maker-First 方案 B：實作與驗收報告

**日期：** 2026-07-31  
**作者：** Manus AI  
**政策版本：** `GLOBAL_MAKER_FIRST_B_V1`

> **風險聲明：** 本報告屬於交易系統工程與風險控制文件，不是投資建議，也不保證降低總交易成本或避免損失。Post-only 可以避免訂單主動吃單，但不能保證成交；真正的緊急退出仍可能產生 taker 費與滑價。

## 一、執行結論

使用者已明確選定並批准**方案 B：分層 Maker-First**。本輪已把原本分散於策略、風控、手動操作與交易所 adapter 的訂單型態決策，收斂到唯一中央執行政策。所有既有及經正式 factory 建立的未來策略，都必須經過相同的 Maker-First facade。

| 執行情境 | 已封印行為 | 是否可轉 taker |
|---|---|---|
| 開倉 | Post-only；每次重讀 best bid／ask | **永不允許** |
| 加倉 | Post-only；每次重讀 best bid／ask | **永不允許** |
| 正常平倉、止盈、人工精確平倉 | Reduce-only + post-only | **永不允許** |
| 硬止損 `STOP_LOSS` | 2 秒 × 2 次 reduce-only post-only | 僅在開關啟用且兩次均未完成後，對**剩餘量**允許一次 emergency taker |
| 最大日虧 `DAILY_LOSS_LIMIT` | 2 秒 × 2 次 reduce-only post-only | 同上 |
| Kill Switch `KILL_SWITCH` | 2 秒 × 2 次 reduce-only post-only | 同上 |

一般流程預設為 **30 秒 × 3 次**。到期後仍有剩餘量時，中央政策回傳失敗／未完成結果並留下 append-only 稽核；不會偷偷改成普通限價或市價。部分成交只處理剩餘量，撤單未獲交易所確認時會 fail-closed，禁止重掛造成雙重 live order。

## 二、根因與修復對照

原始問題不是單一 UI 欄位，而是多層語義不一致。資料庫雖保存 `orderType=limit`，但多個 V2.5、V3.5／V4.x、V5.0、V6.1、V7.0、20415、七彩虹、KRM、風控與手動路徑仍硬編碼 `market`；舊 smart-close 亦可能在普通 limit 逾時後轉 market。普通 limit 若穿越委託簿，仍會以 taker 成交，因此「限價」本身不等於 maker。[1] [2]

| 根因 | 已完成修復 | 主要證據 |
|---|---|---|
| 策略可自行決定 `market`／`limit` | 策略改傳 entry／add／normal-close／emergency-exit intent；中央 facade 決定實際訂單型態 | [`orderPolicyIntent.ts`](../server/exchanges/orderPolicyIntent.ts)、[`makerFirstFacade.ts`](../server/exchanges/makerFirstFacade.ts) |
| 普通 limit 可能立即成為 taker | OKX 使用 `post_only`；Bybit 使用 `PostOnly` | [`okx.ts`](../server/exchanges/okx.ts)、[`bybit.ts`](../server/exchanges/bybit.ts) |
| smart-close 可自動回退 market | 所有一般平倉改由中央 policy 執行；只接受三種明確 emergency reason | [`runtimeGuardedAdapter.ts`](../server/exchanges/runtimeGuardedAdapter.ts) |
| 部分成交可能重複掛全量 | 中央狀態機累計成交量，後續只送剩餘量 | [`makerFirstFacade.test.ts`](../server/exchanges/makerFirstFacade.test.ts) |
| 程序重啟可能遺失未完成訂單 | 穩定 `policyRunId`、完整 snapshot、雙識別查單、DB lease 與 Heartbeat recovery | [`orderPolicyRecovery.ts`](../server/services/orderPolicyRecovery.ts) |
| 新策略可能繞過中央政策 | factory 自動包裝 + 架構守衛掃描原生 adapter、mutation policy context 與 recovery 專用入口 | [`makerFirstArchitecture.test.ts`](../server/exchanges/makerFirstArchitecture.test.ts) |
| 設定修改可能放寬成任意市價 | 後端只允許安全範圍，三種既有 emergency gate 只能個別開關；revision 衝突與設定不可用均 fail-closed | [`orderPolicySettings.ts`](../server/services/orderPolicySettings.ts) |

## 三、中央執行與稽核鏈

唯一一般入口位於 [`factory.ts`](../server/exchanges/factory.ts)。Factory 先建立原生 OKX／Bybit adapter，再套用三模式 runtime guard 與 Maker-First facade。恢復引擎可使用具名且受架構測試限制的原生 recovery 入口，避免同一 `policyRunId` 被第二次包裝成新 intent。

每個 intent 以穩定 `policyRunId` 關聯 append-only 事件。完整鏈路包含 intent、submit、accepted、partial fill、cancel requested、cancel confirmed、reprice、fill、expire、failure 與 emergency submit／fill。事件 metadata 保存政策版本、策略／訊號／決策識別、原始 intent、政策 snapshot、client order id、order id、嘗試次數、成交量與剩餘量。

> **Fail-closed 邊界：** 若政策設定或 append-only 稽核不可用，任何 mutation 都不會送到交易所。若交易所無法確認撤單，中央政策不會建立下一張 child order。

## 四、可重啟恢復與冪等

本輪新增 durable 執行契約與 migration：

| 能力 | 實作 |
|---|---|
| 穩定執行識別 | 每個 run 使用 `policyRunId`，所有事件具索引 |
| 崩潰後狀態重建 | 從 append-only 歷史重建 intent、政策 snapshot、已完成嘗試與累計成交量 |
| 送單成功但 accepted 尚未落庫 | OKX／Bybit 可用 `clientOrderId` 查回交易所真相，封閉此崩潰窗口 |
| 多 instance 互斥 | 資料庫 lease 保證同一 stale run 不被兩個 Autoscale instance 同時接續 |
| 緊急 taker 不確定 | 若 emergency mutation 結果不確定，恢復引擎禁止再次送 taker，以免重複市價平倉 |
| 週期恢復 | Project-level Heartbeat 每分鐘呼叫 cron-only callback，只接受持久化白名單中的 `task_uid` |

Heartbeat `task_uid` 為 `Sjj2uFSV7Bn6TRnqYcH8Qn`。部署傳播期間首次 callback 曾回傳 HTTP 403；其後七次紀錄均為單次嘗試成功、HTTP 200，最新摘要為 `scanned=0, recovered=0, resumed=0, failed=0`。此排程用於重啟後恢復掃描，不取代單一請求內的 2 秒／30 秒 TTL 狀態機。

## 五、可見且安全的控制面

新增側欄入口「**訂單政策**」與 `/order-policy` 頁面。頁面直接讀取後端 immutable rules，不以硬編碼文案宣稱政策。可見內容包括：

| 區塊 | 顯示／可調內容 |
|---|---|
| 不可變安全規則 | 一般流程永遠 post-only；價格來源為每次嘗試重新讀取 best bid／ask；被動偏移 0 tick；部分成交只重掛剩餘量；撤單未確認即停止 |
| 標準流程 | TTL 安全範圍 5–120 秒；最大提交次數 1–5 |
| 緊急流程 | TTL 安全範圍 2–10 秒；maker 次數 2–3 |
| Emergency gate | `STOP_LOSS`、`DAILY_LOSS_LIMIT`、`KILL_SWITCH` 三個開關；不能新增其他理由 |
| 變更控制 | 樂觀 `revision`；衝突不覆蓋新設定；每次變更寫入 append-only 歷史 |

控制面涉及高風險交易政策，因此後端 Zod 與服務層都執行安全範圍驗證。即使繞過前端，仍無法設定 0 秒 TTL、無限重試、任意 emergency reason 或取消 reduce-only 約束。

## 六、測試與驗收證據

| 驗收項目 | 結果 |
|---|---|
| TypeScript | `pnpm exec tsc` 通過，0 error |
| 全套 Vitest | **77 個測試檔、916 項測試全數通過** |
| Production build | `vite build` + server `esbuild` 成功；僅有既有大型 bundle 警告，無建置失敗 |
| 中央狀態機 | 覆蓋 legacy market 改寫、一般 3 次 maker 到期、部分成交、撤單未確認、稽核 fail-closed、未授權 emergency、合法 2×2→taker |
| Durable recovery | 覆蓋送單後崩潰、同 client id 安全重試、部分成交只接續剩餘量、緊急 taker 不確定時不重送 |
| OKX／Bybit payload | 覆蓋 post-only、reduce-only、client id 長度、orderId/clientOrderId 查單、部分成交正規化與無效 post-only fail-closed |
| 設定安全 | 覆蓋安全範圍、設定不可用 fail-closed、revision 衝突與 append-only 事件 |
| 架構守衛 | 阻擋未授權原生 adapter、缺 policy context 的 mutation，以及 recovery 專用入口被其他生產模組使用 |
| UI | 桌面 1440×1000 與行動 390×844 全頁檢查通過；無水平溢位或不可讀警告 |
| tRPC／瀏覽器 | 14:00 後 `orderPolicy.get`／`history` 均 HTTP 200；新頁面 browser ERROR 數為 0 |
| Heartbeat | 持續 HTTP 200；最新 run 無 stale work、無失敗、無重試 |

## 七、尚未執行的高風險驗收

本輪**沒有擅自使用 production 或 testnet 憑證送出驗收訂單**。因此自動化測試已證明程式契約與狀態機，但不能替代交易所 sandbox/testnet 的真實撮合、撤單延遲、post-only 拒單、部分成交與費率觀察。

在啟用實盤前，建議使用明確標示為測試環境的 OKX Demo／Bybit Testnet 憑證，至少持續 48 小時觀察下列項目：

| 階段 | 驗收條件 |
|---|---|
| 開倉／加倉 | 交易所顯示 post-only；無任何未授權 market；成交角色與費率符合帳戶 maker 等級 |
| 正常平倉 | 未成交時撤單確認後才重掛；不得出現 taker fallback |
| 部分成交 | 下一張訂單數量只等於剩餘量；不超平、不反向開倉 |
| 三種 emergency | 各自先完成 2 秒 × 2 次 maker-only；只有剩餘量可觸發一次 taker |
| 重啟 | 在 submit／accepted／partial／cancel 四個窗口分別中斷服務，恢復後不重複送單 |
| 稽核 | 每個 signal、intent、order、fill、cancel、reprice、failure 可由 `policyRunId` 串聯 |

此測試會觸發真實交易所 mutation，必須先取得使用者明確授權，確認測試憑證、交易對、最大名義金額、最大損失與停止條件後才可執行。

## 八、部署與回滾

Durable recovery 里程碑已於 checkpoint `bc1cabfc` 發布。最終設定控制面、架構守衛、交易所契約測試與報告將在本報告完成後保存為新的穩定 checkpoint；本專案已啟用 auto-publish，因此保存 checkpoint 即同步上線。

若上線後發現異常，建議依以下順序處置：先暫停相關策略，再關閉三個 emergency taker gate，最後從管理介面回滾到前一穩定 checkpoint。不要直接刪除 append-only 事件或 recovery schedule；它們是事故追蹤與未完成訂單恢復的依據。

## 九、參考資料

[1]: https://www.okx.com/en-us/help/trading-fee-rules-faq "OKX Trading Fee Rules FAQ"
[2]: https://www.okx.com/help/x-basic-order-types "OKX Basic Order Types"
[3]: https://www.okx.com/docs-v5/en/ "OKX API Guide"
