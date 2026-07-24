
# KAMA 3K 策略數據導出指南

## 方法 1：通過前端 UI 導出（推薦）
1. 打開策略管理頁面
2. 找到「KAMA 3K 策略」卡片
3. 點擊「導出數據」按鈕
4. 選擇導出格式（JSON / CSV）
5. 文件將自動下載

## 方法 2：通過 API 直接導出
使用以下 curl 命令導出完整數據：

```bash
curl -X POST http://localhost:3000/api/trpc/strategies.exportData \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<YOUR_SESSION_TOKEN>" \
  -d '{"strategyId":210008,"format":"json"}' \
  > kama_3k_export.json
```

## 導出數據包含：
- 策略基本信息（名稱、交易對、倉位模式等）
- 所有交易記錄（入場、出場、馬丁層級、盈虧）
- 所有信號記錄（時間、動作、價格、信心度、來源）
- 馬丁狀態歷史（當前倉位、虧損次數、最大層級）
- Heartbeat 輪詢日誌（時間、結果、詳情）
- 統計信息（總交易數、勝率、總盈虧等）

## 導出格式：
- JSON：完整結構化數據，便於程式處理
- CSV：表格格式，便於 Excel 分析
  - trades.csv：交易記錄
  - signals.csv：信號記錄
  - statistics.csv：統計摘要
