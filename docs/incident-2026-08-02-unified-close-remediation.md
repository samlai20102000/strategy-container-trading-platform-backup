# 2026-08-02 V4.0／20415 平倉失敗事故分析與全策略修復報告

## 一、結論摘要

本次畫面所見「V4.0 KAMA+3K 動態馬丁」與「20415 七彩紅馬」反覆顯示限價平倉失敗，**不是限價價格離市場太遠，也不是 OKX 接單後一直未成交**。兩條策略的訂單都在抵達 Maker-First 與 OKX 之前，被 canonical Runtime Gate 因舊部署版本漂移拒絕；因此當時沒有可等待、可撤銷或可重掛的 OKX 限價單。

| 策略 | 畫面／資料狀態 | 真正阻斷點 | 為何表面看來一樣 |
|---|---|---|---|
| `#120011` V4.0／V35-family | 圖片顯示 short `0.1238 BTC`，約每 15 分鐘觸發一次平倉 | `RUNTIME_CAPABILITY_SNAPSHOT_MISMATCH`，Runtime Gate 在 Maker-First 前拒絕 | 前端只顯示泛化「平倉失敗」 |
| `#90003` 20415 七彩紅馬 | 本地 short `0.0047 BTC`，RiskMonitor 約每 10–20 秒重試 | `STRATEGY_LOGIC_HASH_MISMATCH` 加 `STALE_CAPABILITY_MANIFEST`；舊 caller 又缺少穩定 intent、錯誤持久化與退避 | 同樣在 Maker-First 前被擋，且 UI 未顯示實際 Gate 原因 |

昨晚修好的 `#120011` 舊 long `0.0079 BTC` 是另一條已到達 Maker-First 的路徑，事件完整出現 `INTENT_RECEIVED → MAKER_SUBMIT → MAKER_ACCEPTED → MAKER_FILLED`，並取得 OKX 訂單號。今天的 short 平倉則先被 Runtime Gate 擋住，所以是**相同畫面、不同阻斷層**；單純再調整限價價格無法解決。

## 二、圖片與日誌交叉證據

使用者圖片中，20415 在 08:46:18 至 08:48:15 間約每 17–23 秒產生一次「自動交易／平倉／失敗」，V4.0 亦於 08:14:10、08:30:35、08:46:00 重複出現。V4.0 策略卡顯示 OKX short `0.1238 BTC`、均價約 `62,999.97`，而輸出日誌只寫「已觸發平倉，由 V35Monitor 執行」；這只證明策略層作出退出決策，不能代表交易所已成交。

| 證據層 | `#120011` | `#90003` |
|---|---|---|
| 失敗訊號 | 穩定 intent `v35c120011s6299997q12380000`，累積失敗後進入退避 | 舊 RiskMonitor 每輪建立不同時間桶，反覆寫入失敗 |
| `order_policy_events` | 本次 short 失敗沒有事件，證明未進 Maker-First | 本次失敗同樣未進 Maker-First |
| 交易所回應 | 沒有 OKX 拒單回應 | 沒有 OKX 拒單回應 |
| canonical 原因 | capability snapshot 漂移 | strategy logic hash 與 capability manifest 漂移 |

因此，本次必須同時修復 Runtime Gate 的 **reduce-only 安全退出相容層**，以及所有 monitor／risk caller 的統一平倉協調，而不是只修改其中一條策略。

## 三、發布前額外發現的 P0 共享腿風險

在全域 caller 稽核中另發現兩個會令「第二條策略也一樣」甚至造成誤平其他策略倉位的共因。第一，舊 `RiskMonitor` 曾把策略數量放入 `closePositionSmart` 第三參數，但該位置實際是 `timeoutMs`；中央 facade 因未收到策略 owned size，舊行為可能默認以交易所整條聚合腿作 requested size。第二，V3.5、V5.0、V6.1 舊監控器會把交易所聚合 `size／avgPrice` 回寫成單一策略 `totalSize／avgPrice`，令策略錯誤認領同帳戶其他策略或孤兒倉位。

> **安全原則：** 交易所持倉是帳戶聚合事實，不是策略 ownership。任何策略只能 reduce-only 平掉自己本地可證明的 `posSide + requestedSize`；無法證明時必須拒絕，不能猜測或平整條腿。

| 修復項目 | 修復後行為 |
|---|---|
| `CloseExecutionOptions.requestedSize` | 所有策略級平倉明確傳入本地 owned size；無效、缺失或大於交易所腿時，送單前零 mutation 拒絕 |
| `closePositionSmart` 參數 | 第三參數只保留 timeout 語意；數量不得再塞入該位置 |
| 共享聚合腿 | 只平本策略 requested size；後驗以 `初始交易所腿 − requestedSize` 為預期剩餘量，不要求把其他策略持倉歸零 |
| V3.5／V5.0／V6.1 對帳 | 交易所 size／avgPrice 只記錄漂移告警，不再覆寫策略本地 ownership |
| 未歸屬差額 | 保留並顯示 reconciliation／ownership 提示，不自動認領或自動平倉 |

## 四、已下沉至所有現有與未來策略的修復

所有交易狀態變更現統一經過 **Runtime Mode Guard → Maker-First Facade → Exchange Adapter**。Runtime Gate 對增加風險的操作仍維持嚴格 fail-closed；只有已證明為 `reduceOnly`、方向與數量均可靠的舊部署退出，才可繞過純版本漂移。artifact/config 被竄改、策略 key 不符、能力被撤銷、execution mode／policy 不符或 ownership 不完整，仍會拒絕。

| 共用能力 | 現在的全域規則 |
|---|---|
| 一般開倉／加倉／止盈平倉 | Post-Only Maker 限價，TTL 等待；未完全成交則撤單、更新行情並只重掛剩餘量 |
| 一般止盈逾時 | 不可靜默改市價；回傳剩餘量與可重試狀態 |
| 緊急市價兜底 | 只准 `STOP_LOSS`、`DAILY_LOSS_LIMIT`、`KILL_SWITCH` 等核准的 `EMERGENCY_EXIT` |
| 平倉方向 | 必須明確 `symbol + side + posSide + reduceOnly=true`；雙向模式禁止省略 `posSide` |
| 平倉數量 | 必須明確、正數且不超過該策略 ownership 的 `requestedSize` |
| 重複命令 | 同一策略／腿／倉位事實使用穩定 intent；同一 intent 單一飛行 |
| 失敗節流 | 持久化指數退避，由 1 分鐘起，上限 60 分鐘；不再每個輪詢週期刷單或刷訊號 |
| 失敗可觀測性 | 保存 Gate／Maker／Exchange 層級、reasonCode、錯誤原文、intent、方向、數量與下次重試時間 |

現有 `executor`、`RiskMonitor`、V3.5、V5.0、V6.1、V7、KAMA 彩虹馬丁進階 executor、手動精確平倉及 owner 緊急全平入口均已接入同一契約。架構守門測試會阻擋未來策略直接建立原生 OKX／Bybit adapter、略過 Maker-First、缺少 `posSide／reduceOnly／requestedSize`、把數量放入 timeout，或把交易所聚合腿回寫成單一策略 ownership。

## 五、發布前真實持倉狀態

最後一次只讀 OKX `getPositions` 快照為 **2026-08-02 09:53:16–09:53:18（GMT+8）**。整個核對只讀取持倉，沒有送單、撤單或平倉。

| API 帳戶 | OKX 最新實際持倉 | 本地策略 ownership | 判斷 |
|---|---:|---:|---|
| `apiKeyId=1`（`#120011`） | 無 BTCUSDT 持倉 | 本地亦為零 | 圖片中的 `0.1238 BTC` 已不在該帳戶目前持倉中 |
| `apiKeyId=3`（`#90003`） | short `0.0424 BTC`，均價 `62,919.88396` | `#90003` short `0.0047 BTC` | 只有 `0.0047 BTC` 可證明屬於此策略；其餘 `0.0377 BTC` 未被任何本地策略可靠認領 |

為避免誤平其他策略或人工持倉，本輪**沒有自動處理 `apiKeyId=3` 的 `0.0424 BTC` 聚合空腿**。新版本只會允許 `#90003` 對其可證明的 `0.0047 BTC` 發出精確 reduce-only 平倉；`0.0377 BTC` 必須先經人工／帳戶歷史對帳確認歸屬。

## 六、驗證結果

完整 Vitest 最終結果為 **120 個測試檔通過、1 個跳過；1,006 項測試通過、4 項跳過，0 項失敗**。測試涵蓋 one-way／hedge、long／short、Maker-First、部分成交、TTL、撤單重掛、核准緊急 fallback、版本漂移 reduce-only 退出、穩定 intent、退避、共享腿精確 requested size、超額零 mutation 及未來策略架構守門。

| 驗證 | 結果 |
|---|---|
| TypeScript／production build | 通過 |
| 受影響核心測試 | 通過 |
| 全套 Vitest | `1006 passed / 4 skipped / 0 failed` |
| 零主動送單後驗 | 本輪測試／建置時間窗新增 policy event、trade、signal 均為 `0` |
| Server／browser／network 日誌 | 本輪時間窗無新增 runtime error 或 5xx |
| 桌面與手機 UI | 策略管理、訊號日誌均可正常載入；手機策略卡與訊號表可用 |
| 真實交易操作 | 未送出、未撤銷、未平掉任何真實或模擬盤訂單 |

## 七、事故結論與後續操作邊界

本輪已把修復從單一策略提升為全策略共用契約，因此現在的策略和未來新增策略都會沿用 Maker-First、精確策略 ownership、版本漂移安全退出、穩定 intent、部分成交續平及退避機制。第二條策略不再保留繞過這些規則的舊 RiskMonitor 路徑。

仍需分開處理的是 `apiKeyId=3` 現存 `0.0424 BTC` 空腿：程式修復可防止再發生、也可安全限制 `#90003` 只處理 `0.0047 BTC`，但不能憑猜測替使用者判定其餘 `0.0377 BTC` 的歸屬。若要處理該差額，應先核對 OKX 成交歷史、client order ID、人工交易及其他已刪除／停用策略，再決定逐筆 reduce-only 數量；在完成對帳前維持 fail-closed 是正確安全行為。

