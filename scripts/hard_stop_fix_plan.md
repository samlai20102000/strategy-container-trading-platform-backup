# V6.1 Hard Stop 可配置化修改計劃

## 問題
- V6.1 策略的 hard_stop 目前寫死在 V61_REGIME_PARAMS 中：
  - strong_trend: 8.0%
  - weak_trend: 6.5%
  - ranging: 5.0%
- 用戶希望改為可配置，預設 3%，且回測/策略交易/快照完全一致

## 修改文件清單

### 1. server/strategies/v61/strategy_kama_3k_v61.ts
- V61Config 接口：新增 `hard_stop_pct: number` 欄位
- V61_DEFAULT_CONFIG：新增 `hard_stop_pct: 3.0`
- V61_BACKTEST_DEFAULT_CONFIG：新增 `Hard_Stop_Pct: 3.0`（大寫 key）
- V61_REGIME_PARAMS：保留結構但 hard_stop 值改為預設 3.0
- handlePositionManagement：改為讀取 `this.cfg.hard_stop_pct` 而非 `regimeParams.hard_stop`
- 同時保留 regimeParams 中的 max_layers/step/mult（只改 hard_stop）

### 2. client/src/pages/_strategies_dynamic_schema.tsx
- V6.1 schema 中新增 `hard_stop_pct` 欄位定義

### 3. server/routers.ts
- V6.1 input schema（zod）新增 `hard_stop_pct` 欄位

### 4. server/routers/backtest.router.ts
- 確認 snapshot 流程能正確傳遞 hard_stop_pct

### 5. client/src/pages/Strategies.tsx
- V6.1 策略建立表單中映射 hard_stop_pct

## 關鍵決策
- hard_stop 改為統一值（不再按 regime 區分），預設 3%
- 用戶可自行調整（例如設為 5% 或 8%）
- 回測面板自動顯示（因為 V61_BACKTEST_DEFAULT_CONFIG 含 Hard_Stop_Pct key）
