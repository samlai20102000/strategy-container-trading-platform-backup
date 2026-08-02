# KRM S1 方案 B 精準解耦與 M2／H3 凍結稽核報告

**稽核日期：** 2026-08-02  
**策略：** `KAMA_RAINBOW_MARTIN_V1`  
**復原與變更基線：** `f810347d2652ac7bbd86ec81b113c36f84dd4a1a`  
**已發布穩定 checkpoint：** `9fb39799`
**執行原則：** 保留可證明穩定的 S1、回測基礎設施與全域 Maker-First；撤銷 KRM M2／H3 的所有執行認證，直到 cycle-close 完整重設計及本地驗證另案完成。

## 1. 結論

方案 B 已以**能力撤銷而非交易核心回滾**完成精準解耦。KRM 在 BACKTEST、SIMULATION、LIVE 三個 channel 的權威 `supportedModes` 均只保留 `SINGLE_EXCLUSIVE`；M2 `MULTI_POSITION` 與 H3 `HEDGE_GUARDED` 不再由 capability manifest、portfolio adapter resolver、回測 preflight、artifact 建構、部署 preflight、runtime hydration 或前端 catalog 宣告為可執行。

全域 Maker-First、post-only 開／加／平倉、緊急退出 fallback、`policyRunId`、recovery、`posSide`、`reduceOnly`、owned size 與既有 reduce-only 安全退出路徑均未修改。未發布的 cycle-close 半成品已先保存完整證據，再從工作樹移除；本版本**沒有發布任何新的 M2／H3 cycle-close 交易邏輯**。

| 判定 | 範圍 | 本次處理 | 驗收結果 |
|---|---|---|---|
| **保留** | KRM S1 策略、canonical V2 參數、快照、報告、durable job／Heartbeat、27,744 根 O(n) 預計算 | 保持產品行為；只更新能力邊界 | S1 27,744 根重跑與 95 筆基線逐筆一致 |
| **凍結** | KRM M2／H3 回測、模擬、實盤與舊 artifact 啟動／恢復 | 三 channel 只認證 S1；advanced profile 全鏈路 fail-closed | descriptor、catalog、preflight、artifact、runtime 測試通過 |
| **拒絕** | 偽造 capability、stale advanced artifact、舊 M2／H3 deployment、row snapshot 漂移 | 使用既有 machine-readable 守門；runtime 增加窄範圍完整性檢查 | M2／H3 與 snapshot mismatch 均被拒絕 |
| **刪除** | 未發布 cycle-close 半成品與測試產生的暫存策略檔 | 先在專案外保存 patch／hash，再清理工作樹 | 基線完整 Vitest 恢復通過，交付工作樹無測試副作用 |
| **不觸碰** | 全域 Maker-First、交易所 adapter、下單／撤單／平倉核心 | production diff 不含 Maker-First 或 exchange 核心 | Maker-First 全套回歸隨完整 Vitest 通過 |

## 2. 最小 production 變更

Production 程式只修改兩個檔案。`strategyRunnerDescriptors.ts` 是 KRM 三個 channel 的單一能力真相來源；`canonicalRuntimeDeployment.ts` 只處理既有 KRM S1 sealed profile 在能力 manifest 降級後的安全相容。其餘變更均為測試、診斷腳本、文件與待辦紀錄。

| 檔案 | 變更 | 安全邊界 |
|---|---|---|
| `server/services/strategyRunnerDescriptors.ts` | KRM BACKTEST／SIMULATION／LIVE 由 `ALL_MODES` 改為 `S1_ONLY` | 只改 KRM descriptor；其他策略能力不變 |
| `server/services/canonicalRuntimeDeployment.ts` | 增加 `KRM_S1_CAPABILITY_RESEAL` 記憶體相容路徑 | 僅限 KRM、S1、同策略版本、同 logic hash、唯一 blocker 為 stale manifest，且 row snapshot 必須仍等於已驗證的舊 sealed artifact manifest |

> **重要：** reseal 不回寫資料庫、不改策略參數、不升級 mode，也不放寬一般 stale artifact。KRM M2／H3、artifact hash 漂移、policy 漂移、strategy version／logic 漂移、缺失或不一致的 row capability snapshot 仍 fail-closed。既有 reduce-only 安全退出例外維持原樣。

既有全鏈路能力架構會自動傳播 descriptor 降級，因此沒有在每個 router 重複硬編碼 KRM 特例。這使回測 job 建立前與行情下載前的 preflight、portfolio adapter resolution、artifact 建構／相容性、deployment preflight、resume／switch mode、runtime hydration 與 UI catalog 均依同一權威 manifest 判定。

## 3. S1 真實歷史重跑

驗證腳本 `scripts/diagnostics/krm-s1-scheme-b-validation.ts` 重用已修復 S1 基線的 immutable request snapshot，強制 `SINGLE_EXCLUSIVE`，提交正式 durable backtest job，並在程序層監測任何非 GET 的交易／委託 mutation。它不建立模擬客戶資料，也不呼叫實盤下單、撤單或平倉。

| 指標 | 基線 | 方案 B 重跑 | 判定 |
|---|---:|---:|---|
| Baseline job | `job_1785654375277_2786d336` | — | 既有已修復 S1 診斷基線 |
| Validation job | — | `job_1785672350739_ddf5d040` | `COMPLETED`、`errorCode=null` |
| 市場／週期 | BTC-USDT-SWAP／30m | BTC-USDT-SWAP／30m | 相同 |
| K 線數 | 27,744 | 27,744 | 相同 |
| 交易數 | 95 | 95 | 相同 |
| 逐筆 identity hash | `465fe7eba3b9529611c962d77483c5d49b466ca9f97e13f08a3a0f1e614c1c03` | 同左 | `mismatchCount=0` |
| M2／H3 advanced trades | 0 | 0 | 無 advanced 腿洩漏 |
| 觀測到的 exchange mutation | 0 | 0 | 無送單／撤單／平倉 |
| 會計對帳差異 | 0 | 0 | `balanced=true`、`reconciled=true` |
| `this.pnl is not a function` | 無 | 無 | 原破壞未再出現 |

重跑保留原有 `mark_to_market` 終點政策。最終權益為 33,191.15 USDT，已實現 PnL 為 23,193.30 USDT，未實現 PnL 為 -2.15 USDT，期末仍有一筆按市價評價的 S1 開倉；`expectedFinalEquity` 與 `finalEquity` 完全相同，`reconciliationDifference=0`。

## 4. 全鏈路 fail-closed 驗證

新增及重構的回歸測試不只驗證 UI 隱藏，而是鎖定 server-side admission。即使客戶端偽造 advanced capability，KRM M2／H3 仍無法取得 portfolio adapter、通過回測 preflight、建立合法 artifact 或由歷史 sealed deployment 恢復。

| 層級 | 驗證契約 | 結果 |
|---|---|---|
| Descriptor | KRM 三 channel 的 `supportedModes` 僅含 S1 | 通過 |
| UI feed | Backtest catalog 對 KRM 只公開 S1，advanced flags 全為 false | 通過 |
| Adapter resolver | KRM M2／H3 不可解析為 executable portfolio adapter | 通過 |
| Backtest preflight | 偽造的 client capability 不能繞過 server descriptor | 通過 |
| Artifact | current S1 manifest 不接受 KRM advanced execution profile | 通過 |
| Runtime | 舊 KRM M2／H3 sealed profile 不得啟動或恢復 | 通過 |
| S1 compatibility | 完整且唯一差異為 manifest 降級的舊 KRM S1 profile 可只在記憶體 reseal | 通過 |
| Integrity | row capability snapshot 與 sealed artifact 不一致時拒絕 reseal | 通過 |
| Shared O(n) runner | 27,744 根 advanced 成功路徑改由仍正式認證 M2 的 V3.5 驗證 | 通過，未重新開放 KRM M2 |

## 5. Maker-First 不變性

`git diff` 對 `server/exchanges`、Maker-First façade／policy 與相關 shared 核心的變更清單為空。方案 B 沒有修改 order placement、cancel、close、post-only fallback、client order ID、持倉 side 或 owned quantity 邏輯。

| Maker-First 不變量 | 本次狀態 |
|---|---|
| 開倉／加倉／平倉優先 post-only | 未修改 |
| 緊急退出僅在既有 2 秒 × 2 規則後允許 taker | 未修改 |
| `posSide`、`reduceOnly`、策略 owned requested size | 未修改 |
| `policyRunId`、recovery、冪等及後驗歸零 | 未修改 |
| 舊部署版本漂移僅允許既有 reduce-only 安全退出 | 未弱化 |
| 回測路徑交易所 mutation 守門 | 27,744 根重跑觀測值為 0 |

## 6. 工程驗收

最終測試是在收緊 row snapshot 完整性後重新執行，而不是沿用加固前結果。完整 Vitest、TypeScript 與 production build 均成功；桌面與 390×844 手機版回測頁完成視覺檢查。登入狀態不足時無法在瀏覽器手動切換到 KRM，因此 KRM selector 的資料鏈由 server catalog 回歸測試直接鎖定，避免把其他仍認證三模式的策略畫面誤當 KRM 證據。

| 驗收項目 | 最終結果 |
|---|---|
| Vitest | **128 個測試檔通過、2 個跳過；1,052 項通過、5 項跳過；0 失敗** |
| TypeScript | `tsc --noEmit` 成功，0 錯誤 |
| Production build | Vite 2,554 modules 與 server esbuild bundle 成功 |
| Targeted KRM runtime | 12／12 通過，含合法 S1 reseal、snapshot mismatch、M2、H3 |
| Targeted catalog／descriptor | 9／9 通過 |
| 歷史回測 | 27,744／27,744 根完成，95／95 筆逐筆一致 |
| 交易 mutation | 0 |
| Maker-First 核心 diff | 0 個檔案 |
| 正式網域 | `https://tradeauto-ny5chipj.manus.space/` 與 `/backtest` 均以 GET 回應 HTTP 200 |
| 正式站認證守門 | 未登入狀態顯示「登入以繼續」，未嘗試登入或提交任何表單 |

Production build 仍回報既有的大型 JavaScript chunk 警告（主 bundle 約 3.53 MB、gzip 約 714.83 KB）。這是效能優化提醒而非建置失敗，且不由本次兩個 production 檔案變更引入。

## 7. 正式網域唯讀驗證

Checkpoint `9fb39799` 建立後已依專案設定自動發布。正式網域根路徑與 `/backtest` 均以 HTTP GET 回應 200，頁面標題為「策略容器化自動交易平台」；未登入狀態會顯示「登入以繼續」，證明認證守門仍生效。驗證期間未點擊登入、未送出表單、未呼叫任何策略建立／修改 API，也未送出下單、撤單或平倉請求，production 唯讀驗證的交易 mutation 計數為 0。

正式部署的 CSS asset hash 與本地 production build 相同。JavaScript app bundle 由發布環境以其 production 環境變數重新建置，因此 hash 與本地 build 不同；此差異不作為版本失敗判定。Server-side 的 KRM S1-only 權威能力由完整測試、catalog／descriptor 契約及正式 checkpoint 鎖定；未在無登入狀態下繞過認證讀取受保護 catalog。

## 8. OKX live-auth 測試政策

`server/okx-api-auth.test.ts` 原本只要環境中存在憑證便在一般 Vitest 自動呼叫 OKX 私有 API，導致外部網路回傳 HTML／403 時產生非產品回歸的假失敗。它已改為同時要求完整憑證與 `RUN_OKX_LIVE_AUTH_TEST=1` 才執行；預設完整套件會以真正的 `skip` 呈現，不以 `return` 偽裝通過。

此調整沒有修改 OKX adapter 或任何交易邏輯。需要驗證真實連線時，可在受控環境明確 opt-in；本次依零交易 mutation 原則未執行真實帳戶交易操作。

## 9. 凍結後續條件

KRM M2／H3 應持續保持凍結，除非未來另案同時具備：版本化 cycle-close 規則、組合回報分母、共同 trailing 狀態機、M2 budget、H3 recovery／unwind、逐腿與 cycle 級會計、舊 artifact 遷移規則、相同 immutable snapshot 的本地重播、零 mutation 守門、Maker-First 不變性及完整回歸證據。僅完成部分條件不得重新把 `supportedModes` 改回 advanced。

> **最終判定：** 方案 B 已達成「S1 可持續運行、M2／H3 全鏈路不可啟動、既有安全退出不受影響、Maker-First 不倒退、歷史結果可重現」的交付條件。
