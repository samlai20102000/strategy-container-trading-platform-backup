# Pasted_content_19.txt 分析與實作計畫

## 📋 核心需求

實作倉位大小雙模式系統，允許用戶選擇：
1. **USDT 金額模式**：輸入 USDT 金額 → 系統根據當前市價自動換算為 BTC 數量
2. **BTC 數量模式**：直接輸入 BTC 數量

## 🔧 五大修改點

### 修改點 1：前端 UI 表單（StrategyList.tsx）
- 倉位輸入框 + 模式切換下拉選單
- 動態 placeholder 與說明文字
- 支持 `positionValue` 和 `positionMode` 狀態

### 修改點 2：JSON Schema（strategySchema.json）
- 新增 `Base_Lot_Size` 物件結構
- 包含 `value` (數值) 和 `mode` (模式) 兩個屬性
- UI widget 為 `amount-with-mode`

### 修改點 3：後端換算邏輯（strategy_kama_3k_v35.ts）
- `calculateLotSize(config, currentPrice)` 函數
- USDT 模式：`lotSize = positionValue / currentPrice`
- 數量模式：直接使用輸入值
- 確保不小於交易所最小下單量 (0.00001 BTC)

### 修改點 4：馬丁加倉同步（martingaleEngine.ts）
- `calculateMartingaleLotSize(config, currentPrice, layer)` 函數
- 每層根據當前價格動態換算
- 確保金額 = 上一層 × 1.5 倍

### 修改點 5：API 銜接（strategy.router.ts）
- startInstance 接口支持新的 `Base_Lot_Size` 物件格式
- 儲存時保持原樣，執行時再換算

## ✅ 驗收標準

| 測試項目 | 預期結果 |
|---------|---------|
| USDT 模式輸入 10 | 系統根據當前 BTC 價格自動計算數量（如 0.00016） |
| 張數模式輸入 0.001 | 直接使用 0.001 下單 |
| 馬丁加倉 | 每層根據當前價格動態換算，確保金額 = 上一層 × 1.5 倍 |
| 切換模式 | 輸入框 placeholder 和說明文字隨模式變更 |

## 📝 實作順序

1. 前端 UI 修改
2. JSON Schema 更新
3. 後端換算邏輯
4. 馬丁加倉同步
5. API 銜接驗證
6. 端到端測試
