# 測試失敗分析（V4.0 升級後）

## 根本原因
V4.0 重寫了 martingaleEngine.ts 和 riskManager.ts，移除/重命名了舊的 API：
- `getLayerMultiplier` → 已移除（V4.0 使用 getLayerSize）
- `calculateLayerLot` → 已移除（V4.0 使用 getLayerSize + getLayerValue）
- `validateMartinLayers` → 已移除（V4.0 使用 parseMartinLayers）
- `MartingaleEngine` class → 已重寫（previewLayers 靜態方法）
- `RiskManager` class → 已改為函數式（checkHardStopLoss, checkLimitStop）
- `StrategyKama3kV35.calculateLotSize` → 已移除（V4.0 使用 getFirstOrderValue）
- `StrategyKama3kV35.calculateMartingaleLotSize` → 已移除（V4.0 使用 getLayerSize）

## 受影響的測試文件
1. `server/v35-system.test.ts` - 引用舊 API（getLayerMultiplier, calculateLayerLot, validateMartinLayers, RiskManager class）
2. `server/v37-hard-stop.test.ts` - 引用舊 RiskManager class
3. `server/exchange-symbols.test.ts` - 引用舊 calculateLotSize/calculateMartingaleLotSize
4. `server/position-mode.test.ts` - 引用舊 calculateLotSize/calculateMartingaleLotSize
5. `server/v36-stepPct.test.ts` - 引用舊 MartingaleEngine class（engine.getState）
6. `server/v35-optimizations.test.ts` - 引用舊 API

## 修復方案
這些測試需要更新為使用 V4.0 新 API：
- getLayerMultiplier → getLayerSize(layer, config) / getLayerValue(layer, config)
- calculateLayerLot → getLayerSize(layer, config)
- validateMartinLayers → parseMartinLayers (返回 null 表示無效)
- RiskManager class → checkHardStopLoss(state, config) / checkLimitStop(state, config)
- calculateLotSize → getFirstOrderValue(config) / config.Initial_Capital * First_Order_Pct/100
- MartingaleEngine.getState → 直接操作 StrategyState 對象

## 已完成的修復
- [x] StrategyState import type 修復（base.ts, v35Monitor.ts, positionManager.ts, etc.）
- [x] Martin_Layers 恢復到 strategy_kama_3k_v35.ts defaultConfig
- [x] 伺服器成功啟動（無 runtime 錯誤）
- [x] 回測中心 MartinLayersEditor 已恢復顯示
