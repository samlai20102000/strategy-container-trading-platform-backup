# KRM M2／H3 輔助腿重新設計證據底稿

> 狀態：唯讀診斷完成。本文只記錄可從使用者檔案、資料庫及程式碼直接驗證的事實；尚未修改交易邏輯，也未觸發任何實盤送單、撤單或平倉。

## 2026-08-02 使用者本次 M2 回測畫面

來源檔案：`/home/ubuntu/upload/pasted_file_OhwJlm_image.webp`、`/home/ubuntu/upload/pasted_file_2HTF7F_image.webp`。

| 欄位 | 畫面讀值 |
|---|---:|
| 策略 | Kama 彩虹馬丁策略（`KAMA_RAINBOW_MARTIN_V1`） |
| 選擇模式 | `M2 · 雙向獨立` |
| 回測 Job | `bt-3m-1433034275-1785627000000` |
| 總回報 | `-6.27%`／`-627.4 USDT` |
| 勝率 | `0%`，`0 勝／9 負` |
| 最大回撤 | `-8.25%`／`-827.92 USDT` |
| 夏普比率 | `-1.886` |
| 總交易數 | `9` |
| 最大單筆獲利 | `0 USDT` |
| 最大單筆虧損 | `-233.49 USDT` |
| 平均虧損 | `-91.31 USDT` |
| 最大馬丁層數 | `5` |
| 初始資金（由最終權益與總回報反推亦一致） | `10,000 USDT` |
| 已實現損益 | `-821.76 USDT` |
| 未實現損益 | `+194.35 USDT` |
| 對帳差額 | `0.0100 USDT` |
| 最終權益 | `9,372.60 USDT` |
| 有效 K 棒 | `27,744` |
| 期末未平倉估值 | 空單；均價 `80,724.3571`、標記價 `62,788.9000`、數量 `0.010856`、名義價值 `876.32 USDT` |

畫面已能直接確認：本次不是「只顯示部分 CSV」造成的 9 筆錯覺，因為報告摘要本身也把完整回測計為 9 筆，且輸入／回傳有效 K 棒為 `27,744／27,744`。因此，交易數驟減發生在候選生成、模式核准或 cycle／持倉生命週期，而非報告下載端單純漏列。

## 2026-08-02 使用者本次 KRM 配置畫面

來源檔案：`/home/ubuntu/upload/pasted_file_2dNAIW_螢幕擷取畫面2026-08-02165423.webp`、`/home/ubuntu/upload/pasted_file_hX4EFn_image.webp`。

| 設定組 | 畫面讀值 |
|---|---|
| 進場週期 | `M30` closed bar |
| 風控價格 | 持倉監控使用 fresh bid／ask |
| 底倉估算 | `100 USDT` |
| 動態 KAMA 線 | 共 6 條，6 條全部啟用 |
| `KAMA_1` | 名稱 `KAMA 10`；ER 週期 `2`；FAST EMA `2`；SLOW EMA `2` |
| `KAMA_2` | 名稱 `KAMA 20`；ER 週期 `50`；FAST EMA `2`；SLOW EMA `10` |
| `KAMA_3` | 名稱 `KAMA 30`；ER 週期 `50`；FAST EMA `3`；SLOW EMA `10` |
| `KAMA_4` | 名稱 `KAMA 40`；ER 週期 `50`；FAST EMA `4`；SLOW EMA `10` |
| `KAMA_5` | 名稱 `KAMA 50`；ER 週期 `50`；FAST EMA `5`；SLOW EMA `10` |
| `KAMA_6` | 名稱 `KAMA 60`；ER 週期 `50`；FAST EMA `6`；SLOW EMA `10` |
| 方向提示 | 全部啟用線斜率上升才允許 LONG；全部啟用線斜率下降才允許 SHORT；mixed／not-ready／spread 異常 fail-closed |
| 固定模式乘數 | `2` |
| 全域加倉間距 | `2%` |
| 最大加倉層數 | `15` |
| 分層規則 L1–L3 | 每層乘數 `2`；間距 `2%` |
| 分層規則 L4–L6 | 每層乘數 `2`；間距 `2%` |
| 分層規則 L7–L15 | 每層乘數 `2`；間距 `2%` |
| 理論名義倉位 | BASE `100 USDT`、L1 `200`、L2 `400`、L3 `800`、L4 `1,600`、L5 `3,200`、L6 `6,400`、L7 `12,800`、L8 `25,600`；完整理論總估值畫面顯示 `6,553,500 USDT`，實際仍受 deployment position cap、帳戶餘額、qtyStep／minQty 約束 |
| 硬止損 | 以腿級加權平均成本計算 `5%` |
| Trailing 啟動 | `3%` |
| Trailing 回撤 | `1.5%` |
| 階梯步長 | `0.5%` |
| 階梯移動止盈 | 已啟用 |
| 回測對帳 | `MARK TO MARKET`；canonical 配置顯示可保存 |

本次結果與先前 95 筆 S1 基線只有在**相同資料切片、相同策略 canonical 快照、相同交易成本、相同初始資金與相同進出場規則**下才可直接比較。後續將以 Job ID 與 CSV 欄位查證，而不是只依畫面標題假定完全同參數。

## 本次 9 筆 CSV 的直接證據

來源：`/home/ubuntu/upload/pasted_file_ujurhV_backtest_bt-3m-1433034275-1785627000000(1).csv`。

CSV 共 9 筆已關閉交易，分布為 `S1／PRIMARY = 4`、`M2／INDEPENDENT = 5`，共涉及 5 個唯一 cycle。9 筆全部為虧損，逐筆已實現 PnL 合計 `-821.76 USDT`，與畫面已實現損益完全一致；其中 S1 合計 `-297.01 USDT`，M2 合計 `-524.75 USDT`。所有列的 `triggerSource` 都是 `AUTO`，所有列的 `exitReason` 都是 `KRM_MANAGE_CLOSE`。

| Cycle | S1 已關閉時間／狀態 | M2 已關閉時間 | 關鍵事實 |
|---|---|---|---|
| `...1735783200000:1` | 2025-02-27 02:30 | 2025-01-18 03:30 | 兩腿相隔約 40 日各自平倉，非共同平倉 |
| `...1740596400000:2` | 2025-04-25 22:30 | 2025-04-07 14:00 | M2 先於 S1 約 18 日獨立平倉 |
| `...1745593200000:3` | 2025-11-21 15:00 | 2025-05-11 07:00 | M2 先於 S1 約 194 日獨立平倉 |
| `...1763710200000:4` | 2025-12-03 13:30 | 2026-02-04 02:30 | S1 先於 M2 約 63 日獨立平倉 |
| `...1770156000000:5` | 期末仍開放 | 2026-06-02 22:00 | 畫面期末仍有一條空單；M2 已先獨立平倉 |

以上時間差直接證明目前實作**沒有**執行使用者要求的「S1＋M2 組合達目標後兩腿一起平倉」。相反地，兩腿各自進入 `KRM_MANAGE_CLOSE`，且任何一腿可以先關閉；這是獨立腿退出模型，不是依附 S1 的組合退出模型。

CSV 亦顯示每條已關閉腿最後到第 4 或第 5 馬丁層，且每個 cycle 最多一條 M2；這只能證明前一版修復做到了角色歸因、cycle 關聯與 M2 單次資格，不能證明 S1 基線連續運行或共同止盈已正確。

## 95 筆 S1 基線與同參數可比性

來源：`docs/krm-three-mode-baseline-evidence.md` 與 `/home/ubuntu/upload/pasted_file_y0TZKG_backtest_bt_KAMARAINBOWMARTINV1_1785647784050_ohdu89_BTCUSDTSWAP.csv`。

| 基線／重跑 | Job ID | 模式 | 已關閉交易 | 角色分布 | 總回報 |
|---|---|---|---:|---|---:|
| 舊／修復後 S1 基線 | `job_1785647779212_c5d6df85`／`job_1785654375277_2786d336` | S1 | 95 | S1 95 | `+231.91%`（修復後同參數重跑） |
| 前版 M2 修復重跑 | `job_1785654377051_95393c64` | M2 | 9 | S1 4；M2 5 | `-6.27%` |
| 前版 H3 修復重跑 | `job_1785654377496_829afe74` | H3 | 3 | S1 2；H3 1 | `-1.39%` |

保存的基線文件明確記錄三組重跑使用相同 `27,744` 根 BTC-USDT-SWAP／30m K 線、相同日期區間、`10,000 USDT` 初始資金、`100 USDT` 底倉、相同 KAMA／馬丁／移動止盈／硬止損參數，以及 `mark_to_market` 終點政策。因此，`95 → 4` 的 S1 已關閉交易驟減不是參數或資料切片差異可合理解釋，而是模式執行語義改變造成。

## 可追溯資料庫欄位

本地 `data/backtest_data.db` 保存 `backtest_runs`、`backtest_trades`、`performance_metrics`；主資料庫 `backtest_jobs` 保存不可變 `requestSnapshot`、`executionMode`、`executionPolicy`、`executionContext`、`modeResults`、`legAccounting`、`metrics`、`tradesData`、`accounting`、`dataQuality` 與 `engineSemantics`。後續根因驗證將以這些原始欄位和程式碼路徑交叉核對，不只依報告 UI。

### 唯讀診斷結果

診斷腳本：`scripts/diagnostics/krm-redesign-evidence.ts`。執行安全標記為 `READ_ONLY_DIAGNOSTIC_NO_LIVE_TRADE_MUTATION`；腳本只讀使用者 CSV、本地 SQLite 與主資料庫歷史 Job，沒有提交新回測，也沒有觸發送單、撤單或平倉。

| 檢驗 | 結果 |
|---|---:|
| M2 CSV 已關閉交易 | 9 |
| 唯一 cycle | 5 |
| 同時存在已關閉 S1 與 M2 的 cycle | 4 |
| 同時間共同平倉的 cycle | **0** |
| 已配對 cycle 最大平倉時間差 | **194.333 日** |
| SQLite `backtest_trades` 列數 | 9，與 CSV 完全一致 |
| M2 `legAccounting.rejectedDecisionCount` | **315** |
| S1 `legAccounting.rejectedDecisionCount` | **0** |
| M2 overlap duration | `10,398,600,000 ms`，約 `120.354 日` |
| M2 turnover | `29,363.40 USDT` |

`job_1785654375277_2786d336`（S1）與 `job_1785654377051_95393c64`（M2）逐欄比對結果如下：`config`、symbol、timeframe、日期區間、初始資金、底倉金額、終點政策、K 棒數均相同。不可變 request snapshot 只有 7 個差異，全部都位於 execution mode／policy：

| 差異路徑 | S1 | 目前 M2 |
|---|---|---|
| `executionMode` | `SINGLE_EXCLUSIVE` | `MULTI_POSITION` |
| `executionPolicy.maxOpenLegs` | `1` | `2` |
| `executionPolicy.mode` | `SINGLE_EXCLUSIVE` | `MULTI_POSITION` |
| `executionPolicy.oppositeSignalPolicy` | `CLOSE_THEN_WAIT` | `OPEN_INDEPENDENT_LEG` |
| `executionPolicy.allowOneLegPerSide` | 無 | `true` |
| `executionPolicy.isolateExitByLeg` | 無 | `true` |
| `executionPolicy.isolateMartinByLeg` | 無 | `true` |

這一比對把根因範圍縮小到模式 policy 與其在 runtime／kernel 的實作，而不是 KAMA、馬丁參數、資金、日期或資料品質。特別是 `isolateExitByLeg=true` 與 `OPEN_INDEPENDENT_LEG` 從命名到行為都和使用者更正後的「依附 S1 的輔助腿、組合共同平倉」契約相反。

三組資料品質皆為 `27,744／27,744`、零重複／無效／未收盤剔除，且會計皆 `balanced=true`、`reconciled=true`。這表示錯誤不是資料缺損或損益加總失衡，而是**語義正確地執行了錯誤的模式契約**。

## 回測與 live 生命週期的程式級證據

`shared/executionModes.ts` 是目前三模式 canonical contract。M2 的型別、預設值與 normalization 都把 `isolateMartinByLeg=true`、`isolateExitByLeg=true` 及 `oppositeSignalPolicy="OPEN_INDEPENDENT_LEG"` 固定寫死，UI 或舊快照無法把它改成 cycle 共同退出。其顯示文案也明確寫成「風控與馬丁完全隔離」。所以這不是單一回測分支的偶發 bug，而是 canonical policy 本身和使用者更正後的「S1 主腿＋輔助腿＋組合共同平倉」契約相反。

`server/services/backtest/builtInPortfolioRuntimeFactories.ts` 的 KRM adapter 逐一遍歷每條非 HEDGE 腿，分別呼叫 `evaluateKamaRainbowMartinManagement`，再把每條腿各自的 `close`／`add` 決策轉為候選。M2 反向腿雖透過 `cycleIdHint` 綁到 PRIMARY 的 cycle，且用 `m2OpenedCycles` 保證每個 cycle 最多一次資格，但退出仍是逐腿決策；cycleId 在此只做歸因，不是共同風控或共同平倉的執行邊界。

`server/services/backtest/threeModePortfolioKernel.ts` 進一步證明 kernel 沒有 cycle close primitive。`evaluateScopedClose` 只按 `CLOSE_LONG`／`CLOSE_SHORT` 的 side 選腿，`applyCloseCandidate` 再逐一呼叫 `closeLeg`；每次 `closeLeg` 都單獨寫入一筆 trade。kernel 雖在每條腿保存 `cycleId`，但核准 close 時從未按 cycle 擴張 `closeLegIds`，也沒有計算 S1＋輔助腿的組合 PnL。因此 CSV 出現同 cycle 兩腿相隔數十至 194 日退出，是這套 side／leg scoped 路徑的必然結果。

`server/services/advancedExecutionModeEngine.ts` 是回測與 live 共用的進階模式授權層。其 `closeDecision` 同樣只依 side 挑選腿並回傳 `LEG_SCOPED_CLOSE_REQUIRED`；M2 新腿核准結果還在 context 明記 `isolation: "LEG_SCOPED"`。H3 的開腿授權則另外檢查 PRIMARY 浮虧百分比、冷卻與 hedge ratio，但 close 仍沿用同一個 leg-scoped primitive，沒有一般化的 pair／cycle 共同退出語義。

`server/services/kamaRainbowMartinAdvancedSignal.ts` 顯示 live 路徑與回測同源但不是完全同一 adapter：它逐腿恢復 KRM state、逐腿計算 management，再由 `selectManagementCandidate` 每輪只挑一個 close 或 add。M2 開腿確實要求 PRIMARY 已浮虧、反向入場訊號、沒有現存 INDEPENDENT，且該 cycle 未使用過 M2，最後把新腿綁回 PRIMARY 的 cycle；但 M2 平倉訊號只封裝被挑中的單一 `legId`。唯一的協調例外是 H3：PRIMARY 要退出且 HEDGE 存在時，先產生「關 HEDGE」訊號，仍不是兩腿原子或同時共同平倉。

`server/services/kamaRainbowMartinAdvancedExecutor.ts` 證明 live 執行層只接受一個 sealed `targetLeg`。每次 close 只建立一個 order intent、對單一 position side 發一張 market reduce-only 訂單、寫一筆 fill／trade，並只 transition 該 `legId`；程式沒有 cycle-close command、兩腿提交 barrier、第二腿失敗補償或 cycle 級 `CLOSING/CLOSED/RECONCILIATION_REQUIRED` 狀態。因此即使上游未來把兩腿都選中，現有 executor 仍不能保證 cycle 一次協調收斂。

H3 還存在回測／live 的退出語義漂移。回測 kernel 的 `applyAutomaticHedgeLifecycle` 只有在 PRIMARY 的 PnL 已恢復到 `>= 0%` 且滿足 minimum hold 時才關 HEDGE；live `selectH3RecoveryCandidate` 則在 PRIMARY 從 `<= -primaryLossTriggerPct` 恢復到門檻之上時就可關 HEDGE。以預設 5% 為例，live 可在主腿由 -5% 回到 -4.9% 時解除，回測卻要等到 0% 才解除。這會造成 H3 持有時間、對沖損益、再入場冷卻與最終績效無法直接對照，必須在修正前先統一 canonical recovery predicate。

綜合上述，現況已做到「角色分類、同 cycle 歸因、M2 單次資格、H3 門檻與比例限制」，但尚未做到「cycle 是風控／退出聚合根、輔助腿不得單獨結束 cycle、組合達標後共同關閉」。這個缺口同時存在於 policy、候選生成、mode engine、kernel 與 live signal 層，不能只改報告或 CSV 歸因修好。

## 純記憶體重現與拒絕／cycle 量化

診斷腳本：`scripts/diagnostics/krm-advanced-inmemory-root-cause.ts`。原始結果：`docs/krm-m2-inmemory-root-cause.json`、`docs/krm-h3-inmemory-root-cause.json`。腳本直接使用 completed Job 的 immutable request snapshot 與本地 `27,744` 根 K 線，呼叫 advanced runner；不提交 durable Job、不呼叫交易所，也不執行任何 live mutation。

| Parity 欄位 | M2 durable／純記憶體 | H3 durable／純記憶體 |
|---|---:|---:|
| K 棒 | `27,744／27,744` | `27,744／27,744` |
| 已關閉交易 | `9／9` | `3／3` |
| rejected decision | `315／315` | `6／6` |
| 已實現 PnL | `-821.76／-821.76` | `-440.16／-440.16` |
| 期末未平倉腿 | `1／1` | `1／1` |

M2 的 315 次拒絕已全部拆解：`287` 次 `RISK_MARGIN_USAGE_LIMIT`、`28` 次 `RISK_GROSS_NOTIONAL_LIMIT`；候選動作為 `ADD_SHORT=252`、`ADD_LONG=63`。也就是說，315 次不是入場訊號被拒，而是腿在 2 倍馬丁擴張過程中反覆觸及共享 margin／gross 上限。這些拒絕解釋加倉停止，卻不能解釋 `95 → 4` 的主交易數驟減；後者由長壽命 cycle 佔用造成。

M2 只有 5 個 PRIMARY entry，其中僅 2 個與 95 筆 S1 基線 entry timestamp 重合；其餘 **93 個基線入場時點全落在某條 M2 cycle 仍有 open leg 的區間**。其中 85 個時點仍有 PRIMARY，另有 8 個時點已只剩 INDEPENDENT 輔助腿。最長 cycle 佔用 `209.667` 日，期末未結 cycle 已佔用 `179.083` 日。這直接證明「任一腿存活即阻止下一個 S1 cycle」加上「逐腿分離退出」會壓縮主策略的連續交易能力。

H3 的 `7,412` 個 decisions 中，`7,386` 次為 `H3_LOSS_THRESHOLD_NOT_MET` HOLD、`7` 次為 `H3_ACTIVE_RATIO_LOCKED` HOLD、`6` 次為 margin limit REJECT；只建立 2 條 PRIMARY 與 2 條 HEDGE。兩個 cycle 分別佔用 `189.813` 日及 `387.083` 日，後者期末仍開放。95 筆 S1 基線中有 **94 個 entry timestamp** 未成為 H3 PRIMARY；這 94 個全落在某條 H3 cycle 的 open-leg 區間，其中 **71 個時點只剩 HEDGE、PRIMARY 已關閉**。這是 H3 保護腿反客為主、長期阻斷下一個主 cycle 的直接量化證據。

`server/services/backtest/threeModePortfolioKernel.test.ts` 已新增一個通過式 characterization：同 cycle 開 PRIMARY 與 INDEPENDENT 後，只送 PRIMARY close，結果只產生一筆 PRIMARY trade，INDEPENDENT 仍保持 open；decision 明確為 `CLOSE_ONLY／LEG_SCOPED_CLOSE`。目標測試檔共 `12／12` 通過。此測試不是認可現況，而是把待修契約缺口固定成可重現基線，後續 cycle-close 實作時應改寫為「同一 close intent 關閉同 cycle 全部依附腿」。
