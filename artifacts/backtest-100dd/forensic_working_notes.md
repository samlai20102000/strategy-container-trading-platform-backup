# 100% 最大回撤法證工作紀錄

## 事故識別

- 使用者附件：`/home/ubuntu/upload/testing2.xlsx`
- SHA-256：`fec9203b1185bc14dc445fb5ba3544705dc533adc52a8f69aaa41a7debfe5424`
- 工作表：`backtest_bt_KAMARAINBOWMARTINV1`
- 持久化 job：`job_1785770356467_b7fe7008`
- 策略：`KAMA_RAINBOW_MARTIN_V1`
- 交易對／週期：`BTC-USDT`／`30m`
- 初始資金：`10,000 USDT`
- 區間：`2025-01-01T00:00:00Z` 至 `2026-08-01T23:59:59Z`
- 建立／完成：`2026-08-03T15:19:16Z`／`2026-08-03T15:19:24Z`

## Excel 獨立重算

- 平倉交易 91 筆：90 勝、1 負，勝率 `98.9011%`。
- 平倉淨損益合計 `20,861.23 USDT`；唯一虧損 `-1.82 USDT`。
- 只以平倉權益計算的最大回撤：`1.82 USDT`／`0.0180919%`。
- 畫面總回報 `20,859.08 USDT` 與平倉淨損益差 `-2.15 USDT`，恰等於期末未平倉部位的未實現淨損益；期末會計帳平。
- 因此 Excel 交易檔只含已平倉交易，不能描述持倉期間的 mark-to-market 回撤。

## 持久化 equityCurve 法證

- equityCurve 持久化點數：`2,001`；來源完整 K 線：`27,744`。
- 非正權益點共 `5` 個。
- 回撤前峰值：`11,401.08 USDT`，時間 `2025-05-12T18:00:00Z`，價格 `101,601.2`。
- 首次破產：`2025-05-22T07:00:00Z`，權益 `-3,242.48 USDT`，價格 `110,700`。
- 最低權益：`2025-05-22T14:00:00Z`，權益 `-5,253.88 USDT`，價格 `111,225.8`。
- 當時持有 cycle 29、layer 11 的 BTC 空單：均價 `107,090.42`、數量 `3.8238715736209605 BTC`、名義價值約 `409,500.01 USDT`、mark-to-market 毛虧約 `-13,802.57 USDT`。
- 該筆後來於 `2025-06-01T16:00:00Z` 以 `105,111.71` 平倉，最終被記成獲利 `+7,241.75 USDT`。
- 這證明 100% 回撤不是顯示或績效公式誤差，而是模擬器允許已破產部位繼續存活並等待反彈。

## 宣告政策與實際行為矛盾

- job `environment.leverage = 1`。
- job `executionContext.executionPolicy.riskBudget.maxGrossNotionalPct = 100`。
- job `executionContext.executionPolicy.riskBudget.maxMarginUsagePct = 40`。
- 實際 layer 11 名義曝險為初始資金的 `40.95 倍`；亦遠超當時權益。
- job 宣告 `riskModelVersion = gross-margin-liquidation-v2`，但 KRM S1 runner 未執行集中風險預留與 margin liquidation。

## 程式碼根因

- `backtestEngine.ts` 只在 `executionPolicy.mode !== SINGLE_EXCLUSIVE` 時把策略派送至 `runAdvancedKamaPortfolioBacktest`／`ThreeModePortfolioKernel`。
- S1 KRM 直接走 `runKamaRainbowMartinBacktest`。
- `kamaRainbowMartinBacktest.ts` 雖建立 `simulatedAccount`，但該函數完全未被呼叫；檔案內沒有 `executionPolicy`、`riskBudget`、`maxGrossNotionalPct` 或 `maxMarginUsagePct` 的准入檢查。
- `applyEntryOrAdd` 直接套用馬丁加倉；逐 K 僅寫入 `equity + unrealizedPnl`；權益非正時沒有清算、終止或 fail-closed。
- `calculatePerformance` 對負權益採有限責任口徑，將 trough 截為零並把回撤上限設 100%；此計算在已破產路徑上是正確的，不是根因。
- 共用 `ThreeModePortfolioKernel` 已有 `reserveRisk`（總名義／保證金限制）及 `applyMarginLiquidation`（維持保證金／非正權益強制平倉），但 S1 獨立 runner 沒有使用。

## 系統影響面

- `backtestEngine.ts` 的 M2／H3 路徑統一走 kernel；S1 則仍分流至多個獨立 runner。
- 已確認 KRM 與 Rainbow Trend Ladder 的 S1 runner 都是本地現金帳本加 mark-to-market，沒有共用 execution-policy／liquidation hook。
- `backtestEngine.ts` 內 20415、V2.5、generic、V70 亦各走 bespoke S1 路徑；風控語義不完全一致，需以全策略共用 guard 或統一 kernel 收斂，而不是只改 KRM。

## 尚需完成

- 從完整 equity curve 重算並釐清 `maxDrawdownUSDT` 持久化值 `11,450.29` 與持久化抽樣曲線重算 `11,401.08` 的 `49.21 USDT` 差異；初步判斷為完整 27,744 點計算後，再把曲線降採樣至 2,001 點造成關鍵峰／谷遺失。
- 確認九策略清單：`strategy_20415`、`RAINBOW_TREND_LADDER_V1`、`KAMA_RAINBOW_MARTIN_V1`、`KAMA_3K_BREAKOUT_V25`、`20415_KAMA_MARTIN_V35`、`20415_KAMA_MARTIN_V41`、`KAMA_3K_ULTIMATE_V50`、`KAMA_3K_HF_V61`、`KAMA_3K_TORNADO_V70`。
- 實作共用 S1 資金／名義曝險／保證金／破產守門、不可恢復破產狀態、回撤證據持久化與 UI 診斷標籤。
- 建立全九策略回歸矩陣，驗證回測不再宣告不存在的 risk model coverage。

## 真實資料無持久化重播補充

使用同一 job 設定重新抓取 OKX `BTC-USDT` 30m 已收盤 K 線後，重播仍在 `2025-05-22T07:00:00Z` 產生非正權益，且交易數仍為 91、勝負仍為 90／1、最大回撤仍為 100%。API 重抓資料與原 job 的價格有小幅差異，故總回報與回撤 USDT 不可拿來取代原 job 數值；但事故時間、馬丁路徑與破產機制可重現。

改用 `session.equityCurve` 的 27,745 個逐 K 完整點後，重播首次非正權益提前精確定位到 `2025-05-22T02:00:00Z`（-1,523.38 USDT），前一根 01:30 尚為 449.06 USDT；最低權益為 -7,155.05 USDT。原 job 的持久化曲線只有 2,001 個降採樣點，因此只能看到 `2025-05-22T07:00:00Z` 的 -3,242.48 USDT，不能代表真正首次破產時間。兩者都證明回撤 100% 不是顯示或計算錯誤。

重播精確捕捉 cycle 29 的 12 個持倉層（報表 `martinLayer=11` 表示 11 次加倉，不是只有 11 個持倉層）。初始層為 100 USDT，後續依序為 200、400、800、1,600、3,200、6,400、12,800、25,600、51,200、102,400、204,800 USDT，累計入場名義價值 409,500 USDT。

依 job 宣告政策逐層重算，**第 6 個持倉層**（2025-04-25 14:30 UTC，新增 3,200 USDT）已首次違反 `maxMarginUsagePct=40`：預計保證金 6,450.32，當時風險權益 11,098.61，政策上限 4,439.44。**第 7 個持倉層**（2025-05-02 14:30 UTC，新增 6,400 USDT）再首次違反 `maxGrossNotionalPct=100`：預計總名義 13,010.75，當時風險權益／總名義上限 10,936.90。Runner 對這兩次及其後所有超限加倉均未拒絕。

在首次非正權益時，重播 state 顯示持有 12 個層、3.822515 BTC 空單、加權均價 107,128.41、累計入場名義 409,500 USDT，mark 名義約 423,197.18 USDT。當時維持保證金（0.5%）約 2,115.99 USDT，而權益已為負，明確應觸發共用 kernel 的 `MARGIN_LIQUIDATION`；但獨立 S1 runner 未執行。

## 全鏈路稽核補充

- `performanceCalculator.ts` 對每個有效權益點採 `boundedEquity = max(0, equity)`，故負權益後最大回撤為 100%，符合有限責任語義；它沒有製造破產，而是暴露 runner 已讓帳戶破產。其總回報使用最後一個權益點，故負權益後若 runner 繼續交易並恢復，仍可顯示正總回報。
- `kamaRainbowMartinBacktest.ts` 先以完整曲線計算 metrics，再把曲線降採樣為最多約 2,001 點保存及回傳。負權益點未被拒絕，job 仍標記 `completed`。
- `BacktestReport.tsx` 直接顯示同一 `metrics.maxDrawdown` 與 `metrics.maxDrawdownUSDT`，未做重新計算或欄位錯配；畫面 100%／11,450.29 是後端結果的忠實顯示。
- `finalizeV25Result()` 對 SINGLE_EXCLUSIVE 只驗證終點帳本與 metadata 一致，沒有要求 liquidation／bankruptcy 證據；同時無條件寫入 `riskModelVersion=gross-margin-liquidation-v2`、`intrabarEventPolicy=risk_first` 與 executionPolicy。這使未執行風控的 S1 run 看起來像已套用該模型，屬於 provenance／capability claim 錯誤。

## 全策略架構影響與 canonical 語義

- 九個內建策略在 `SINGLE_EXCLUSIVE` 模式不是統一走 `ThreeModeBacktestPortfolio`：20415、Rainbow Trend Ladder、KRM、V2.5、V3.5／V4.1／V5.0／V6.1 共用 inline runner、V7.0 各有本地帳本或專屬 runner。只有 M2／H3 由引擎強制走共用 portfolio kernel。
- 全專案搜尋顯示，`RISK_GROSS_NOTIONAL_LIMIT`、`RISK_MARGIN_USAGE_LIMIT`、`MARGIN_LIQUIDATION`、`ACCOUNT_BANKRUPT` 的可執行實作只存在於 `threeModePortfolioKernel.ts`；KRM、Rainbow Trend Ladder、20415、通用 S1 與 V7.0 runner 都未直接執行這套政策。
- KRM 的 `simulatedAccount()` 計算 mark equity、used margin 與 margin usage，但沒有任何呼叫點；`applyEntryOrAdd()` 在核心決定後直接把 fill 套入狀態，沒有 pre-order reserveRisk。逐 K 更新只把 `equity + unrealizedPnl` 寫入曲線，沒有 margin liquidation 或 bankruptcy stop。
- 通用 S1 runner 另有舊式 `Max_Position_Ratio`、`Max_Equity_Drawdown` 與 hard-stop；V7.0 另有價格百分比 hard-stop／MA 強平，但兩者與 executionPolicy 的 gross／margin budget 不是同一契約，且沒有 canonical `ACCOUNT_BANKRUPT` 狀態。這代表「風控是否真的執行」隨 runner 漂移，不能由 metadata 推定。
- `buildLegacyS1LegAccounting()` 事後以交易結果推導 gross exposure 與 margin headroom；即使 margin headroom 已是負數，也沒有把結果標成 bankrupt 或拒絕 completed。`finalizeV25Result()` 隨後仍保存 `status=completed`。
- 專案既有權威測試 `threeModePortfolioKernel.test.ts` 明定有限責任語義：觸發 `MARGIN_LIQUIDATION`、final equity 為 0、`bankrupt=true`、曲線最低只能為 0，後續重入必須以 `ACCOUNT_BANKRUPT` 拒絕。KRM 本次 run 的負權益與後續恢復直接違反此 oracle。

## 上一輪修正的反證

- 目前 `buildOpenPositionSnapshot()` 被改成 `unrealizedGrossPnl - exitFees`，註解聲稱入場費已在平倉時計算而不應重扣；但 runner 在開倉時並未從 `equity` 扣除 entry fee，只有平倉時才把 entry＋exit fee 一次納入 closed-trade PnL。
- canonical 測試 `server/backtest-v25-continuity.test.ts` 對 2 單位、100 入場、110 mark、0.1% 費率的期望是 `20 - 0.2 = 19.8`，即 mark-to-market 扣已發生的 entry fee。實際執行得到 19.78，造成 1 failed／15 passed。
- 因此上一輪 entry fee → exit fee 修改是次生回歸，必須回復；但該差額僅為當下 entry／exit notional 費用差，量級不足以解釋 11,450.29 USDT 回撤。100% 回撤唯一主因仍是未執行風險准入與清算，不能再以 fee 口徑遮蔽。
