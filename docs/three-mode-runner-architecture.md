# S1／M2／H3 Strategy Runner Architecture

## 目標

回測、模擬、部署與實盤不得再各自維護策略 key 白名單。任何策略來源（策略定義、策略實例、參數快照、回測 artifact、部署 artifact）都必須先解析成同一個 **strategy identity + runner descriptor + capability manifest**，再選擇執行路徑。

「支援所有策略」代表 runner registry 能解析每一個已註冊策略，且未來策略透過相同契約接入；不代表在缺少逐腿語義時把 S1 策略假裝成 M2／H3。M2／H3 只有在 descriptor 具備獨立腿狀態、精確腿平倉及 H3 hedge guard adapter 時才可由系統自動發布認證。

## 單一真相

每個策略只有一個 `StrategyRunnerDescriptor`，內容包含：

| 欄位 | 用途 |
|---|---|
| `strategyKey` | 與策略類別、DB definition、instance、snapshot、artifact 對齊的 canonical key |
| `strategyVersion` | artifact 與 deployment 相容性版本 |
| `logicRevision`／`strategyLogicHash` | 封印實際策略語義，而非 UI 名稱 |
| `normalizeConfig`／`validateConfig` | 單一參數正規化與 fail-explicit 驗證入口 |
| `runnerId`／`runnerVersion` | 歷史記錄、可觀測性與可重現性 |
| `supportedModes` | 由已註冊 adapter 能力推導，不由另一張白名單宣告 |
| `runBacktest` | S1／M2／H3 的同一派送入口 |
| `capabilityEvidence` | independent leg state、precise leg close、hedge guard 的機器可驗證證據 |

`VersionedStrategyCapabilityManifest` 仍是策略定義、實例、快照與部署所攜帶的封印契約，但其內容只能由 descriptor registry 生成。`strategyStudio`、`strategyCapabilityRegistry`、`backtestEngine` 與 UI 不得再自行推測能力。

## Adapter 邊界

`ThreeModePortfolioKernel` 是共用帳本、成交、風控與 S1／M2／H3 狀態機。策略 adapter 只負責產生該策略真實語義的 entry／management 候選。

| 策略族 | Adapter 語義 |
|---|---|
| 20415 七彩虹 | M30 七線 entry、盲人模式、逐層加倉、停損／止盈與 fill state transition |
| 七彩虹趨勢階梯 | 趨勢方向、階梯馬丁、每腿 management 與成交後 state transition |
| KRM | 六線 KAMA、cross／touch lock、每腿馬丁、硬止損、階梯 trailing、exit-first |
| V2.5 | 底倉、3K breakout、trailing、馬丁與專屬 close／fill transition |
| V4.1 | AND／OR 三條件、三 K、fast／slow、price／slow、方向限制、持續條件重入 |
| V3.5／V5.0／V6.1 | 沿用現有 advanced KAMA 候選，但從 runner 內硬編碼分支抽成具名 adapter |
| V7.0 | MA200、KAMA、S-curve、逐層倉位與策略專屬 signal state |
| 未來／自訂策略 | 註冊時必須提供 descriptor；缺少 descriptor 不得悄悄落入 generic EMA runner。只提供 S1 adapter 時只認證 S1，提供完整 portfolio adapter 後自動發布 M2／H3 |

目前九個內建 strategy key 均具備版本一致的 executable portfolio factory；任何 factory 缺失、factory/descriptor 版本不一致或 requested mode 不在認證集合中，都會在載入歷史 K 線和建立 job 前失敗，不會回退到 generic KAMA／EMA 近似。

## 新增策略接入門檻

未來策略必須沿用下列單一路徑，不得另加前端白名單或 runner `if/else`：

1. 在 `strategyStudio` 註冊真實策略實例、canonical key 與完整預設參數。
2. 註冊唯一 `StrategyRunnerDescriptor`，封印 strategy version、logic revision、adapter ID/version 與各 channel 認證證據。
3. 讓策略定義、instance、snapshot 與 artifact 使用同一 canonical identity；不可只在 UI 新增名稱。
4. 若要支援 M2／H3，註冊可執行 `PortfolioStrategyRuntimeFactory`，直接調用該策略的 entry／management／fill state transition，不得以其他策略核心近似。
5. BACKTEST capability 只能由 descriptor registry 生成；Backtest Center 只讀 `backtestModeCapabilities`，不得讀 LIVE 或 SIMULATION capability。
6. 新增策略的 CI 必須驗證：策略實例存在、預設參數完整、descriptor/factory 版本一致、S1／M2／H3 runtime 可建立、缺失 factory 會 fail explicit，以及回測結果保存 runner identity。

## 執行順序

1. 解析 strategy key 與 runtime strategy。
2. M2／H3 從 registry 取得 descriptor；不存在即 `RUNNER_DESCRIPTOR_MISSING`。S1 舊自訂策略可維持相容路徑，但不會因此取得 M2／H3 認證。
3. 正規化及驗證 config。
4. 驗證 request identity、strategy version、logic hash、manifest hash 與 descriptor 一致。
5. 驗證 requested mode 存在於 descriptor 推導的 manifest。
6. 在建立 job 與載入歷史 K 線前執行共享 preflight，確認 executable factory 存在且版本一致，並建立 runner execution context；能力不符立即以結構化錯誤 fail explicit。
7. 執行 adapter + shared kernel。
8. 歷史記錄保存 runner ID／version、descriptor hash、stage 與結構化錯誤；未進入 runner 不得顯示 `legacy`。

## 不變安全規則

- 未知策略、未知 descriptor、過期 artifact、hash 不符或 adapter 缺失一律 fail closed。
- 不可用 generic KAMA／EMA 指標近似另一策略的 M2／H3 語義。
- H3 必須具備 hedge guard、逐腿數量及精確關閉證據；保護腿不得繼承主腿馬丁。
- 所有回歸測試使用純函式／stub／歷史 K 線，不接觸 OKX 真實下單路徑。
- 未來策略新增流程必須有全域 registry 一致性測試；只改 UI、manifest 或 runner 任一處都應使 CI 失敗。
