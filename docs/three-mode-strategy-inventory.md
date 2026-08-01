# 全策略 S1／M2／H3 盤點矩陣

## 修復後狀態

| Strategy key | BACKTEST 能力 | 可執行 portfolio factory | 真實語義來源 | Channel 邊界 |
|---|---|---|---|---|
| `strategy_20415` | S1／M2／H3 | `rainbow-20415-portfolio` | 七彩虹純核心、盲人模式、entry／management／fill transition | 僅 BACKTEST 已認證三模式；其他 channel 由各自證據決定 |
| `RAINBOW_TREND_LADDER_V1` | S1／M2／H3 | `rainbow-trend-ladder-portfolio` | 七線趨勢階梯純核心與腿級 management | 同上 |
| `KAMA_RAINBOW_MARTIN_V1` | S1／M2／H3 | `kama-rainbow-martin-portfolio` | 六線 KAMA、cross／touch lock、腿級馬丁與 fill transition | 同上 |
| `KAMA_3K_BREAKOUT_V25` | S1／M2／H3 | `kama-3k-v25-portfolio` | `evaluateV25Decision` 與 V2.5 close／fill transition | 同上 |
| `20415_KAMA_MARTIN_V35` | S1／M2／H3 | `kama-3k-v35-portfolio` | V3.5 entry／management action API | 同上 |
| `20415_KAMA_MARTIN_V41` | S1／M2／H3 | `kama-3k-v41-portfolio` | V4.1 AND／OR、三 K、方向限制、持續條件重入與 V3.5 management core | BACKTEST 三模式；LIVE／SIMULATION 仍只公開已各自認證的能力 |
| `KAMA_3K_ULTIMATE_V50` | S1／M2／H3 | `kama-3k-v50-portfolio` | V5.0 F1–F6 與策略專屬 action API | 同上 |
| `KAMA_3K_HF_V61` | S1／M2／H3 | `kama-3k-v61-portfolio` | V6.1 ATR／regime／每日限制與逐腿 management | 同上 |
| `KAMA_3K_TORNADO_V70` | S1／M2／H3 | `kama-3k-v70-portfolio` | V7.0 MA200、KAMA、S-curve 與逐層 state | 同上 |
| 自訂／未來策略 | 只公開有證據的模式 | 必須顯式註冊且版本與 descriptor 一致 | 策略本身的真實 evaluator／state transition | 沒有 descriptor 或 executable factory 時，M2／H3 在建立 job 前 fail explicit；不會落入 generic portfolio runner |

## V4.1 原始根因與修復

V4.1 原本不是單純漏掉 UI 開關，而是 capability channel、手工白名單與可執行 runner 三者漂移。Backtest Center 又曾讀取 LIVE capability，因此即使 BACKTEST 有三模式證據，M2／H3 仍可能顯示未認證。

修復後，V4.1 由 `StrategyRunnerDescriptor` 產生 BACKTEST capability，Backtest Center 只讀 `backtestModeCapabilities`；`kama-3k-v41-portfolio` executable factory 直接調用 V4.1 真實 entry evaluator，不再用固定 fast/slow KAMA fallback。共享 preflight 在建立 job與載入 K 線前同時驗證 descriptor、mode、factory 與版本。

## 目標完成條件

所有 runtime 策略都必須可由 registry 解析成 descriptor。S1 至少有明確 runner；M2／H3 則由逐腿 adapter 的機器證據自動推導。策略定義、實例、快照、artifact、回測、部署與 UI 必須共享相同 key、version、logic hash、runner ID、runner version 與 mode capabilities。未來策略若缺少 descriptor 或所選模式 factory，建立任務前即以結構化 `RUNNER_PREFLIGHT` 錯誤 fail explicit，不得落入錯誤的 generic runner。
