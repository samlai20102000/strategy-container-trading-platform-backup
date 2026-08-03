# 策略直接啟用：圖片與程式鏈核對記錄

## 使用者圖片（2026-08-03）

- 畫面位於「策略交易」，使用者從快照建立了 `Kama彩虹馬丁策略 - 導入`。
- 建立成功 Modal 顯示策略「已建立並保持停用；完成參數複核後才可手動啟用」，並仍包含 TradingView Webhook 操作說明。
- Modal 內黃色安全提示仍寫「V4.1 新策略預設停用，目前不會自動下單；請先檢查入場邏輯、快照身份與回測證據，再由策略卡片主動啟用」。
- 右下通知明確寫：原引擎鎖定為 `KAMA_RAINBOW_MARTIN_V1`，`必須通過部署 preflight 後才可啟用`。
- 策略卡背景顯示啟用切換與 `運行中`，但下方執行記錄同時出現 `HOLD` 與 `ARTIFACT_INCOMPATIBLE:STRATEGY_LOGIC_HASH_MISMATCH,STALE_CAPABILITY_MANIFEST`，代表 UI 狀態與實際 runtime admission 不一致。
- 使用者要求：快照導入後可直接由策略卡啟用新交易；並要求排查一般新建策略是否同樣被 preflight 阻擋，若是則一併取消。

## 已定位的程式鏈

- `server/routers/backtest.router.ts` 的 `requireCompatibleSnapshotArtifact()` 目前對快照執行 `assertStrategyArtifactCompatible()`；舊快照的 strategy logic hash 或 capability manifest 變更會在建立／套用前直接阻擋。
- `importSnapshotAsNew` 使用 `buildDisabledSnapshotDeploymentFields()`，把新策略寫成 `activationState: DISABLED`，並回傳「必須通過部署 preflight 後才可啟用」。
- `server/routers.ts` 的一般 `strategies.create` 也把新策略寫成 canonical `DISABLED`，disabled reason 同樣要求 preflight。
- `strategies.toggle` 與 `strategies.setStatus(status=running)` 對所有非 `LEGACY` 策略拒絕直接啟用，要求改走 deployment preflight／activate，因此快照導入與一般新建都受影響。
- `assessStrategyArtifactCompatibility()` 將 `STRATEGY_LOGIC_HASH_MISMATCH` 與 `STALE_CAPABILITY_MANIFEST` 一律列為 blocker；這對封存的 deployment execution profile 有意義，但不應阻擋僅把快照參數導入目前已註冊策略引擎的日常策略建立流程。
- 快照導入 KRM 的頂層 `reentryEnabled` 目前仍被寫死為 `false`，須同步修正為 canonical `kamaRainbowMartinConfig.reentryEnabled`，否則新策略卡狀態標籤及 runtime 會與快照不一致。

## 目標行為

- 快照導入與一般新建均先建立為停用，**不自動交易**；但不再要求已從一般 UI 移除的 S1 deployment preflight。
- 使用者在策略卡主動切換啟用後，策略可進入既有 runtime；啟用前仍需通過 API 帳戶歸屬、交易所／交易對、策略配置、倉位與風控參數等必要校驗。
- 快照 artifact 的引擎身份、hash 完整性與配置驗證仍保留；對「同一已註冊引擎的新版本」採目前引擎重新正規化參數並記錄相容警告，而非以 stale manifest／logic hash 阻斷。
- deployment 工作台的 lifecycle preflight、封存 execution profile 與底層部署 API 保留，這次只解除一般策略 CRUD／策略卡啟用對該流程的不當依賴。
