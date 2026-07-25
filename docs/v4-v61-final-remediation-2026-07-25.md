# V4.0 KAMA 硬止損與 V6.1 OKX 持倉模式最終修復紀錄

**日期：** 2026-07-25  
**作者：** Manus AI  
**範圍：** V4.0／V35 硬止損、Autoscale 排程互斥、策略停用一致性、OKX `posMode` 下單契約，以及相關回歸測試。

> 本次處理只修正系統邏輯與已確認的錯誤配置。受影響策略 #7 仍維持停用，沒有自動啟用、下單、平倉或改變任何持倉。

## 一、最終根因

V4.0 畫面出現「浮虧達到 0% 而停用」並非單一前端顯示問題，而是由三個底層缺陷共同造成。首先，舊快照中的 `Max_Loss_Pct` 為 `0`，舊監控路徑可能把它當成可比較閾值，因此即使浮虧率為 `0%`，仍會滿足「浮虧率大於或等於 0」的條件。其次，Autoscale 環境曾同時依賴程序內 `setInterval`、全域風控與策略 Heartbeat；多個 revision 或 instance 可同時檢查同一策略，造成重複平倉、重複停用與重複通知。最後，停用資料庫更新沒有以 `enabled = true` 作為狀態轉移條件，併發請求可能把同一停用事件重複記錄。

V6.1 的 OKX 錯誤 `51010` 則源於下單 payload 與帳戶實際 `posMode` 不一致。雙向持倉模式必須送出 `posSide=long|short`；單向持倉模式必須省略 `posSide`。舊 adapter 沒有在每次下單前以真實帳戶配置建立一致 payload，模擬子帳號因而被 OKX 拒絕。

| 問題 | 根本原因 | 最終防線 |
|---|---|---|
| V4 於 0% 誤觸硬止損 | `Max_Loss_Pct=0` 被當成閾值 | 監控層將缺值、空白、0、負值、NaN 回退為 5%；引擎層對非有限或非正閾值 fail-closed |
| V4 重複平倉／停用 | 多個監控路徑與 Autoscale 多實例並行 | Production 只由 Heartbeat 觸發；V35 auto-trade 使用資料庫跨實例租約 |
| 重複停用通知 | 非條件式資料庫更新 | `id + enabled=true` 原子更新，只有 `affectedRows=1` 才視為首次停用並通知 |
| V6.1 OKX 51010 | `posSide` 與 `posMode` 不一致 | 每次送單前讀取真實帳戶模式；雙向送 long／short，單向省略 posSide，未知模式拒絕下單 |
| V35 被其他 KAMA 策略誤分類 | 使用過寬 `includes("KAMA")` | 只接受精確鍵 `20415_KAMA_MARTIN_V35` |
| 移動止盈平倉失敗後重入 | 未確認平倉結果便執行 close-split | 只有交易所確認平倉成功後才允許重置、成功通知或順勢重入 |

## 二、已實作的永久性修復

### 2.1 單一生產排程與跨實例互斥

`server/_core/index.ts` 在 production 不再啟動任何程序內風控輪詢。V35 僅由該策略的 `/api/scheduled/auto-trade` Heartbeat 執行；泛用、V50 與 V61 風控則由單一 `/api/scheduled/riskCheck` Heartbeat 執行。泛用 RiskMonitor 明確跳過 V35，避免第二套止損語義再次介入。

`server/services/barLock.ts` 新增資料庫跨實例租約。租約具有獨立 scope、TTL、owner token 與所有權釋放檢查；舊請求即使逾時，也不能刪除新實例接手的租約。租約覆蓋 V35 的風控、信號生成與交易執行全流程，所有成功、提前返回與例外路徑均在 `finally` 安全釋放。

### 2.2 V4 硬止損雙層防護

`server/services/v35Monitor.ts` 的配置正規化只接受有限正值。`null`、`undefined`、空白字串、`0`、負值及 `NaN` 一律回退至安全預設 `5%`，並記錄原始值、有效值與是否使用 fallback。`server/services/martingaleEngine.ts` 再以獨立 fail-closed 條件保護底層計算，非有限價格、非法初始資本、無持倉或非正閾值均不得觸發硬止損。

硬止損判斷現在每輪只計算一次；平倉失敗會保留馬丁狀態供下一次 Heartbeat 重試，不會假裝平倉成功、清空狀態或停用策略。移動止盈亦採相同安全邊界：只有交易所確認平倉成功後，才可重置狀態、發送成功通知或依既有 close-split 決策順勢重入。

### 2.3 原子停用與通知去重

`server/db.ts` 的策略停用改為 `WHERE id = ? AND enabled = true` 的條件更新。只有資料庫回報一筆狀態真正由啟用轉為停用時，呼叫端才建立首次停用事件及發送通知；重試、舊 revision 或併發 instance 不會重複通知。

### 2.4 OKX `posMode` 契約一致化

`server/exchanges/okx.ts` 在每次下單與設定槓桿前讀取 OKX `/api/v5/account/config`。`long_short_mode` 依買賣方向送出 `posSide=long|short`；`net_mode` 不送 `posSide`；未知或缺失模式直接阻擋下單，不以猜測值冒險送單。模擬盤請求持續攜帶 `x-simulated-trading: 1`，帳戶診斷程序也回報真實 `posMode` 與預期 payload 行為。

## 三、資料安全處理

唯讀檢查確認唯一受舊 0% 快照影響的是策略 #7。該策略的 `Max_Loss_Pct` 已由 `0` 修正為 `5`，停用原因改為需人工覆核的安全提示，並明確維持 `enabled=0`。此次沒有啟用策略、建立訂單、平倉或修改持倉。

同一份唯讀資料稽核也確認策略 #7 共有 8 筆交易，其中 4 筆為已成交平倉，`realizedPnl` 缺值數為 0，累計已實現盈虧為 **0.00799 USDT**。舊畫面顯示 `0.00` 的直接原因是共用 `PnlValue` 固定使用兩位小數，而不是平倉資料未寫入。現在一般金額仍維持兩位小數；絕對值小於 0.01 的非零盈虧則保留最多六位，避免真實小額盈虧被誤顯示為零。

| 核對項目 | 最終狀態 |
|---|---|
| 策略 ID | 7 |
| 啟用狀態 | 停用（`enabled=0`） |
| 快照 `Max_Loss_Pct` | 5 |
| 舊「0% 硬止損」原因 | 已替換為人工覆核提示 |
| 已成交平倉／缺失 PnL | 4／0 |
| 累計已實現盈虧 | 0.00799 USDT |
| 自動交易／平倉操作 | 未執行 |

## 四、驗收結果

| 驗收項目 | 結果 |
|---|---|
| Vitest 確定性測試 | 36 個檔案通過；471 項通過 |
| OKX live 公網整合測試 | 4 項改為明確 opt-in；以 `RUN_OKX_INTEGRATION_TESTS=1` 執行 |
| TypeScript | `tsc --noEmit` 通過 |
| 生產建置 | Vite 與 server bundle 通過 |
| 執行期啟動 | 服務正常監聽，無新增 import、型別或啟動錯誤 |
| UI／資料唯讀核對 | 策略列表可載入；策略 #7 維持停用且快照顯示 5% |
| V4 盈虧閉環 | 初始狀態、長／短平倉 realizedPnl、非法成交資料 fail-closed、績效聚合、回撤與小額顯示精度均有確定性回歸 |
| 全域風控 Heartbeat | `global-risk-check-v4-v61` 已啟用；task UID `2UkhZjFe7SGf4BdnzqeunS`；首次執行 HTTP 200，218 ms |

OKX 公網交易對測試依賴 sandbox 對 `www.okx.com` 的外部網路；先前失敗均為連線逾時，而非斷言或本次程式回歸。為維持 CI 可重現性，預設 Vitest 不再把 live 網路狀態當作單元測試成敗條件，但 live 驗證入口仍完整保留。

## 五、營運建議

發布後已建立每分鐘單一 `/api/scheduled/riskCheck` Heartbeat，以驅動泛用、V50 與 V61 風控；各策略的 auto-trade Heartbeat 繼續負責信號與交易，其中 V35 由自身 auto-trade 路徑完成專屬風控。此任務可在專案排程管理介面以 task UID `2UkhZjFe7SGf4BdnzqeunS` 查看執行歷史、暫停或調查失敗。策略 #7 在重新啟用前，應由使用者人工確認 5% 硬止損、API 金鑰、OKX 模擬子帳號模式與預期持倉方向；建議先在模擬盤持續觀察至少 48 小時，再考慮實盤。

## 六、結論

本次不是以隱藏 0% 顯示或放寬錯誤處理暫時繞過問題，而是同時封堵配置、計算、排程、併發、資料庫狀態轉移及交易所 payload 六個邊界。V4 的 0% 誤停用來源已被雙層攔截，跨實例重複處理已由資料庫租約與原子更新消除；平倉盈虧亦由正式計算函式、有限值聚合及自適應顯示形成完整資料閉環。V6.1 的 OKX 下單則改為以真實 `posMode` 建立 payload，避免同類 51010 錯誤再次出現在其他策略。
