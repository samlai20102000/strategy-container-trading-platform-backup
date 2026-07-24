# KAMA 3K V5.0 極致優化版 — 實施計劃

## 策略 Key
`KAMA_3K_ULTIMATE_V50`

## 核心差異（vs V3.5）
V5.0 在 V3.5 的 KAMA+3K+馬丁基礎上新增六大模組：
- **F1 市場制度切換**：ADX(14)+ATR(14) 判斷強趨勢/弱趨勢/震盪，動態覆蓋馬丁參數
- **F2 部分獲利**：層數≥4/6/8 時分批平倉 30%/30%/20%
- **F3 ATR 動態止盈**：TP_Pct = MAX(tp_min_pct, ATR/price × tp_atr_multiplier)
- **F4 時間濾網**：UTC 12-22 時段外不開新倉
- **F5 波動率倉位**：首單 = base_lot × (target_vol / current_ATR_pct)，限 0.5x-2.0x
- **F6 AI 輔助過濾**：KAMA 斜率方向 + 成交量放大 + 支撐阻力過濾

## KAMA 參數（V5.0 預設，與 V3.5 不同）
- 快線：length=30, fastest=8, slowest=2
- 慢線：length=55, fastest=10, slowest=8

## 市場制度參數對應表
| 參數 | 強趨勢 | 弱趨勢 | 震盪 |
|------|--------|--------|------|
| step(1-3) | 2.0% | 1.5% | 1.0% |
| step(4-6) | 3.0% | 2.5% | 2.0% |
| step(7-9) | 4.0% | 3.0% | 3.0% |
| step(10-13) | 5.0% | 4.0% | 4.0% |
| mult(1-4) | 1.5× | 1.6× | 1.8× |
| mult(5-9) | 1.2× | 1.3× | 1.2× |
| mult(10-13) | 1.0× | 1.0× | 1.0× |
| max_layers | 13 | 11 | 9 |
| hard_stop | 8.0% | 6.5% | 5.0% |

## 需要新增/修改的文件

### 後端（不動 V3.5 任何文件）
1. `server/strategies/v50/strategy_kama_3k_v50.ts` — V5.0 策略引擎類
2. `server/services/v50Monitor.ts` — V5.0 實盤監控器
3. `server/services/backtest/backtestEngineV50.ts` — V5.0 回測路徑
4. `server/services/indicators.ts` — ADX/ATR 計算模組（共用）
5. `server/config/strategySchemas.ts` — 新增 KAMA_3K_V50_SCHEMA（不動 KAMA_3K_SCHEMA）
6. `server/services/strategyStudio.ts` — 註冊新策略（BUILT_IN_KEYS 新增）
7. `server/routers.ts` — 新增 v50Config schema + 創建/更新處理
8. `server/services/registryManager.ts` — 無需改動（自動從 strategyStudio 拉取）

### 前端（不動 V3.5 的 V35ConfigPanel）
9. `client/src/pages/_strategies_v50_panel.tsx` — V5.0 專用配置面板
10. `client/src/pages/Strategies.tsx` — 新增 V5.0 分支（v50Config payload + panel 渲染）
11. `client/src/pages/_strategies_dynamic_schema.tsx` — 新增 V5.0 schema 路徑
12. 回測中心前端 — 自動支持（已通過 registry 動態載入）

### 策略名稱統一修改功能
13. `server/routers.ts` — 新增 `registry.renameStrategy` mutation
14. `server/services/registryManager.ts` — 新增 renameStrategy 方法
15. `drizzle/schema.ts` — strategy_definitions 表已有 name 欄位
16. 前端設定頁 — 策略名稱編輯 UI

## 回測引擎整合方式
回測引擎 `backtestEngine.ts` 已有 `isV35` 分支。V5.0 策略將：
- 新增 `isV50 = request.strategyKey === "KAMA_3K_ULTIMATE_V50"` 分支
- 在 V50 路徑中實現完整的 F1-F6 模組邏輯
- 共用現有的 KAMA 計算、平倉分流、績效計算等基礎設施

## 實盤監控整合方式
- 新建 `v50Monitor.ts`，與 `v35Monitor.ts` 完全獨立
- 使用相同的 heartbeat 排程觸發（在 runRiskCheck 中新增 V5.0 策略過濾）
- 監控循環增加 F1 市場制度判斷、F2 部分獲利、F3 動態止盈
