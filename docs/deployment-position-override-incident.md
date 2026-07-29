# 全策略實盤部署倉位覆寫故障紀錄

## 使用者截圖證據（2026-07-29）

來源附件：`pasted_file_rgjjir_螢幕擷取畫面2026-07-29124131.webp` 與 `pasted_file_Jb3Xea_image.png`。

從快照導入「七彩虹線趨勢跟蹤階梯馬丁策略」時，部署表單的「實盤部署倉位」已由快照原始值 **100 USDT** 改為 **500 USDT**；介面也明確標示「可獨立覆寫」，快照原始倉位仍為 100 USDT。建立後策略卡片卻顯示倉位 **100.00000000 USDT**，證明使用者最終部署覆寫值在伺服器持久化期間被快照 `Base_Lot_Size` 反向覆蓋。

## 已定位的覆蓋路徑

1. `server/routers.ts` 一般建立策略時，七彩虹階梯分支以 `rainbowTrendLadderConfig.Base_Lot_Size` 優先於 `input.positionSize`／`input.positionMode`。
2. `server/routers.ts` 更新策略時，只要提交七彩虹階梯配置，就再次以配置中的 `Base_Lot_Size` 覆蓋頂層部署倉位。
3. `server/routers/backtest.router.ts` 從快照建立新策略時，也以七彩虹階梯快照倉位優先於使用者輸入。
4. `server/services/registryManager.ts` 將 V2.5 快照套用至既有策略時，會直接改寫 `positionSize`、`positionMode` 與 `positionSizeObject`。

## 應維持的系統不變量

**回測／快照倉位是策略研究配置；實盤部署倉位是策略實例的最終執行配置。** 快照只能作為部署表單初始建議值，之後不得在建立、更新、重新套用快照、訊號生成或下單時覆蓋使用者確認的頂層部署倉位。頂層 `positionSize`、`positionMode` 與 `positionSizeObject` 必須同步持久化，並由所有現有與未來策略共用同一解析契約。
