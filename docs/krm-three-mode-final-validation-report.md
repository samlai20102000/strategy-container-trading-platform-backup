# Kama 彩虹馬丁 S1／M2／H3 三模式修復與驗證報告

**作者：Manus AI**  
**完成日期：2026-08-02（GMT+8）**  
**適用策略：`KAMA_RAINBOW_MARTIN_V1`**

## 執行摘要

本次修復已把 Kama 彩虹馬丁的 **S1 主腿、M2 獨立反向腿與 H3 自動保護腿**，從策略訊號、canonical mode gate、portfolio kernel、實盤 executor、回測報告、CSV 與歷史資料持久化串成同一條可追溯契約。M2 現在只能在 S1 浮虧且出現相反入場訊號時建立，同一 S1 cycle 最多一條；H3 在 S1 達既有版本化浮虧門檻時自動建立，不等待相反 KAMA 入場訊號，且禁止馬丁加倉。[1]

> 本輪所有驗證均走回測、純決策函式或 mock executor；沒有觸發任何真實下單、撤單或平倉 mutation。實盤路徑的修改以 fail-closed 測試驗證，不以真實帳戶試單。

最終完整驗證為 **128 個測試檔通過、1 個既有測試檔跳過；1,042 項測試通過、4 項既有測試跳過**。TypeScript 檢查與 production build 均成功。另以舊版 95 筆 S1／6 筆 M2 的 immutable request snapshot，對同一組 27,744 根 BTC-USDT-SWAP 30 分鐘 K 線執行三組修復版 durable 回測，三組皆完成且會計對帳為 `balanced`。[2]

## 根因與修復邊界

原先三模式資訊在訊號層、模式核准層與回測腿之間缺少明確的 **角色與 cycle 身分契約**。部分路徑只能由 execution mode、方向或當下腿狀態推測 `PRIMARY`、`INDEPENDENT`、`HEDGE`，造成 M2 cycle 資格、H3 自動保護與報告標註可能分歧。另一方面，portfolio kernel 雖已具備共享資金與腿級會計基礎，但 KRM adapter 未完整表達「M2 與 S1 同 cycle、M2 自己持有馬丁狀態、H3 禁止馬丁」等策略專屬語義。

報告鏈的另一個缺口是腿角色在關腿後未完整保留到通用交易紀錄、SQLite 歷史資料、前端表格與 CSV；舊 UI 因而可能把 execution policy 模式當成真實部署腿來源。這不是單純顯示問題，因為刷新歷史報告後，`cycleId`、`legId`、角色與觸發原因也可能遺失，無法由逐筆交易重算或稽核。

本輪修改限於 KRM 專用決策與共用三模式契約的向後相容擴充。其他策略若不提供角色提示，仍沿用原有 mode engine 行為；角色提示不是繞過風控的捷徑，而是必須通過 canonical mode gate 驗證，不一致時立即拒絕。

## 最終策略契約

| 項目 | S1 | M2 | H3 |
|---|---|---|---|
| 腿角色 | `PRIMARY` | `INDEPENDENT` | `HEDGE` |
| 開腿條件 | 無既有主腿時的正常入場 | S1 浮虧、出現相反入場訊號、同 cycle 尚未使用 M2 | S1 浮虧達 canonical H3 門檻，自動建立 |
| cycle | 建立新 cycle | 沿用受輔助 S1 的 cycle | 沿用受保護 S1 的 cycle |
| 馬丁 | 依 KRM 設定 | 使用自己的全新腿級狀態，從初始層開始 | 禁止加倉 |
| 資金 | 共用策略資金池 | 共用策略資金池 | 共用策略資金池 |
| 報告模式 | `S1` | `M2` | `H3` |

M2 的底倉建立時不會繼承 S1 的 `currentLayer`、最後加倉價或 trailing 狀態。逐筆報告中的 `martinLayer` 表示該腿關閉時的最終層級；因此某條 M2 在自身生命週期內加倉後可能顯示第 4 或第 5 層，這不代表它從 S1 的第 4 層開始。回測 kernel 與實盤 executor 測試均另外固定了 M2 新腿的初始層級行為。[1]

## 核心實作

| 資料流 | 修復內容 |
|---|---|
| 共用契約 | `CandidateIntent`／mode signal 新增可選且受驗證的 `roleHint`、`cycleIdHint`，保留其他策略相容性。 |
| Canonical mode gate | 核准 KRM 的 S1／M2／H3 明確角色；提示與模式、既有腿或 sealed identity 不一致時 fail closed。 |
| KRM 回測 adapter | M2 僅在 S1 浮虧與反向訊號同時成立時產生，每 cycle 一次；H3 由浮虧門檻自動產生；H3 跳過馬丁管理。 |
| KRM 實盤訊號 | sealed signal 保存腿角色與 cycle；以歷史腿查詢永久判斷該 cycle 是否已用過 M2。 |
| KRM 實盤 executor | 將 sealed role／cycle 傳入 mode gate；signal 與 options 的 leg／cycle 身分衝突時，在任何下單前拒絕。 |
| Portfolio kernel | 輔助腿可沿用 S1 cycle，同時保留自己的數量、均價、層級、損益及觸發來源；共享 gross／margin 上限不重置本金。 |
| 回測報告 | 關腿時保存 `deploymentMode`、`role`、`cycleId`、`legId`、`triggerSource`、`entryReason`、`exitReason`。 |
| 歷史持久化 | SQLite 表以向後相容 migration 新增歸因欄位，insert／read round-trip 保留 camelCase 報告契約。 |
| 前端與 CSV | 逐筆交易新增 S1／M2／H3 模式欄；tooltip 與 CSV 提供 cycle、leg、角色、觸發與原因供稽核。 |

## 同參數回測驗收

舊版基線使用 BTC-USDT-SWAP、30 分鐘週期、2025-01-01 至 2026-08-01、10,000 USDT 初始資金、100 USDT 部位、相同 KRM v2 策略參數。舊版輸出為 S1 95 筆、M2 6 筆；這兩個數字只作錯誤行為診斷基線，沒有被當成修復後的硬編碼期望。[2]

| 部署模式 | 修復版 Job ID | 已關閉交易 | 腿角色分布 | 總回報 | 最終權益 | 會計 |
|---|---|---:|---|---:|---:|---|
| S1 | `job_1785654375277_2786d336` | 95 | S1／PRIMARY 95 | +231.91% | 33,191.15 USDT | balanced |
| M2 | `job_1785654377051_95393c64` | 9 | S1／PRIMARY 4；M2／INDEPENDENT 5 | -6.27% | 9,372.60 USDT | balanced |
| H3 | `job_1785654377496_829afe74` | 3 | S1／PRIMARY 2；H3／HEDGE 1 | -1.39% | 9,860.73 USDT | balanced |

M2 的五條輔助腿全部保存為 `deploymentMode=M2`、`role=INDEPENDENT`，開腿原因為 `KRM_M2_LOSS_REVERSE_LONG` 或 `KRM_M2_LOSS_REVERSE_SHORT`，並沿用對應 S1 cycle。九筆已關閉交易分布於五個唯一 cycle，沒有任何 cycle 建立第二條 M2。[2]

H3 的保護候選來源為 `KRM_H3_AUTO_PROTECTION_CANDIDATE`，不依賴相反 KAMA 入場訊號。已關閉 H3 的 `addCount=0`；另有一條 H3 在 `mark_to_market` 終點政策下仍開放，其未實現損益已納入最終權益，因此已關閉交易數不等於曾建立的 H3 腿總數。[2]

## 測試與建置結果

| 驗證 | 結果 |
|---|---|
| KRM 精準回歸 | 10 個測試檔、55 項測試全數通過 |
| 完整 Vitest | 128 個測試檔通過、1 個既有檔案跳過；1,042 項通過、4 項既有 skip |
| TypeScript | `pnpm check` 通過，無型別錯誤 |
| Production build | Vite 與 esbuild 成功；僅保留既有大 bundle 警告，不影響建置完成 |
| 回測資料庫 | 新歸因欄位 migration 與 insert／read round-trip 測試通過 |
| 桌面視覺驗收 | `/backtest` 於 1440×1000 完整頁面正常，三模式選擇、策略參數與歷史區域無版面破損 |
| 實盤安全 | 回測架構守門與 executor mock 驗證通過；本輪未執行真實交易 mutation |

## 已知說明

修復版 M2 與 H3 的收益不是舊 S1 結果的加總，也不應以舊 6 筆 M2 為目標。三種模式有不同的共用資金競爭、腿生命週期與期末未實現部位，應以各自完整 portfolio 權益為準。H3 門檻沿用 KRM 已版本化 canonical 4% 保護值；前端漂移值不會覆寫此策略專屬封印，未知 policy 版本則 fail closed。[1]

目前 production build 有單一前端 bundle 超過 Vite 500 kB 的非阻斷警告。這是既有容量優化議題，不影響本次 KRM 三模式語義、會計或發布；若後續需要，可另以 route-level dynamic import 進行拆包，避免在策略修復中混入無關重構。

## References

[1]: ./krm-three-mode-contract-v2.md "KRM 三模式最終契約"
[2]: ./krm-three-mode-baseline-evidence.md "KRM 舊基線與修復版同參數重跑證據"
