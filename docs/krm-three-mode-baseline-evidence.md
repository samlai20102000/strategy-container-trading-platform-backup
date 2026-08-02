# KRM 三模式修復基線證據

記錄日期：2026-08-02（GMT+8）

## 正式資料庫基線

| 基線 | Job ID | 模式 | 交易筆數 | 策略 | 交易對／週期 |
|---|---|---:|---:|---|---|
| S1 | `job_1785647779212_c5d6df85` | `SINGLE_EXCLUSIVE` | 95 | `KAMA_RAINBOW_MARTIN_V1` | `BTC-USDT`／`30m` |
| 舊 M2 | `job_1785646858931_95c6b036` | `MULTI_POSITION` | 6 | `KAMA_RAINBOW_MARTIN_V1` | `BTC-USDT`／`30m` |

兩次基線使用相同行情與策略參數，僅 execution mode／policy 不同：

- 日期：`2025-01-01T00:00:00.000Z`（`1735689600000`）至 `2026-08-01T23:59:59.000Z`（`1785628799000`）
- 初始資金：`10000 USDT`
- 部位：`100 USDT`
- 終點政策：`mark_to_market`
- KRM config version：`kamaRainbowMartin.v2`
- KAMA 線：ER／Fast／Slow 分別為 `2/2/2`、`50/2/10`、`50/3/10`、`50/4/10`、`50/5/10`、`50/6/10`
- 馬丁：`gapPct=2`、`multiplier=2`、`maxLayers=15`，分段 `1–3`、`4–6`、`7–15`
- 移動止盈：啟用，`activationPct=3`、`callbackPct=1.5`、`stepPct=0.5`
- 風控：`hardStopLossPct=5`、`maxGrossNotionalPct=100`、`maxMarginUsagePct=40`

## 診斷用途

上述 95 與 6 是舊版本輸出，只作錯誤行為基線，**不可預設修復後交易筆數或收益**。修復版必須以相同 immutable request snapshot 重跑，逐筆輸出 `deploymentMode`、`role`、`cycleId`、`legId`、`triggerSource`、`entryReason`、`exitReason` 及 PnL 歸因，再由實際結果判定 S1／M2／H3 筆數。

## 驗證環境備註

沙箱瀏覽器於 2026-08-02 07:02Z 開啟 `/backtest` 時停在 Manus OAuth 登入頁，未使用或索取任何使用者憑證。因此同條件重跑改由專案既有、同源且明確禁止交易 mutation 的後端回測 runner 執行；不以瀏覽器登入作為策略語義驗收前提。

## 修復版同參數重跑結果

三組工作均使用上述相同 27,744 根 BTC-USDT-SWAP／30m K 線、同一 KRM 參數與 10,000 USDT 初始資金，且均由 durable backtest runner 完成、`status=completed`、`errorCode=null`。

| 部署模式 | 修復版 Job ID | 總交易 | 角色分布 | 總回報 | 最終權益 | 會計對帳 |
|---|---|---:|---|---:|---:|---|
| S1 | `job_1785654375277_2786d336` | 95 | S1／PRIMARY 95 | +231.91% | 33,191.15 USDT | balanced |
| M2 | `job_1785654377051_95393c64` | 9 | S1／PRIMARY 4；M2／INDEPENDENT 5 | -6.27% | 9,372.60 USDT | balanced |
| H3 | `job_1785654377496_829afe74` | 3 | S1／PRIMARY 2；H3／HEDGE 1 | -1.39% | 9,860.73 USDT | balanced |

### M2 歸因證據

- 五條 M2 都以 `deploymentMode=M2`、`role=INDEPENDENT` 保存，不再誤標為 S1。
- M2 開腿原因為 `KRM_M2_LOSS_REVERSE_LONG` 或 `KRM_M2_LOSS_REVERSE_SHORT`，並沿用對應 S1 的 `cycleId`；九筆已關閉交易共五個唯一 cycle，符合每個 S1 cycle 最多一條 M2。
- 逐筆交易的 `martinLayer` 是**關腿時的最終層級**，此次五條 M2 在腿內獨立加倉後最終到第 4／5 層，並不代表從 S1 的第 4 層開腿。kernel 與實盤 executor 測試另行驗證 M2 新腿初始為第 1 層，第一次加倉由該腿自己的下一層推進。

### H3 歸因證據

- H3 不等待反向 KAMA 入場訊號，由 `KRM_H3_AUTO_PROTECTION_CANDIDATE` 自動建立，`deploymentMode=H3`、`role=HEDGE`，並沿用受保護 S1 的 `cycleId`。
- H3 腿在 leg accounting 中 `addCount=0`，證明保護腿沒有馬丁加倉；H3 模式此次有一條已關閉 H3 與一條期末仍開放的 H3，期末未實現損益已納入最終權益。
- H3 的一筆保護腿依既有極端回撤規則退出；另一筆在 `mark_to_market` 終點政策下保留為未平倉腿。最終權益對帳仍為 balanced。

> 舊 95／6 僅是錯誤行為基線。修復後 M2 為 4 筆 S1 + 5 筆 M2，而非把舊 6 筆硬湊成預期；H3 為 2 筆 S1 + 1 筆已關閉 H3，另有一筆期末未平倉 H3。所有數字均來自實際 runner 輸出，未使用硬編碼預期。
