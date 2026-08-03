# 策略直接啟用契約

## 決策

策略交易頁的兩條一般建立路徑——**從快照導入為新策略**與**一般新建策略**——採用相同契約：建立成功時保持停用，但歸類為可由策略卡直接管理的 `LEGACY` runtime。使用者檢查設定後，可主動切換為啟用；不再要求進入已從 UI 移除的 S1 部署工作台，也不再依賴 deployment preflight 才能開始運行。

canonical deployment API、部署狀態機、preflight 報告與部署路由仍完整保留。只有透過該專用部署流程建立的 canonical deployment 繼續遵守其原有 preflight 與 lifecycle transition；本次不得放寬該隔離契約。

## 建立與啟用狀態

| 場景 | 建立後 enabled | 建立後 activationState | 使用者下一步 |
|---|---:|---|---|
| 從參數快照導入新策略 | `false` | `LEGACY` | 在策略卡確認配置後主動啟用 |
| 一般新建策略 | `false` | `LEGACY` | 在策略卡確認配置後主動啟用 |
| 專用 canonical deployment 流程 | `false` | 原 canonical lifecycle 狀態 | 沿用既有 preflight／activate 流程 |

建立 mutation **不得自動啟用**，前端也不得在建立成功後代替使用者切換狀態。啟用仍是一個明確、可回滾且由使用者觸發的操作。

## 快照相容性與配置安全

快照導入仍必須滿足以下硬性條件：策略引擎身份存在且已註冊、快照引擎不可改選、配置能通過該引擎的 canonical schema 正規化、API 帳戶屬於目前使用者、交易所與策略綁定一致、倉位與槓桿輸入有效。

`STRATEGY_LOGIC_HASH_MISMATCH` 與 `STALE_CAPABILITY_MANIFEST` 這類可安全升級的版本診斷，不再把一般策略導向 deployment preflight；系統會以目前已註冊引擎重新正規化配置、建立新的 S1 artifact，並保留來源追溯。`ARTIFACT_HASH_MISMATCH`、策略身份不一致、未知策略、配置 schema 無效或能力已撤銷等完整性／身份錯誤仍然 fail closed，不得導入。

## 直接啟用的必要本機校驗

策略卡要求啟用時，後端仍先確認策略屬於目前使用者，並且只允許 `LEGACY` runtime 使用該切換；canonical deployment 仍拒絕 legacy toggle。API 帳戶、交易所／交易對、槓桿、倉位單位與策略配置已在建立／快照導入時驗證並持久化，實際 runtime admission 與交易執行守門仍照常生效。本次不送測試單、不自動下單，也不替使用者自動啟用。

## 自動重新入市標籤

策略列表只在 KAMA 彩虹馬丁卡片顯示 `自動重新入市：已啟用` 或 `自動重新入市：未啟用`。值必須從 canonical KRM 配置讀取；頂層相容欄位只能作為舊資料 fallback，不得讓其他策略誤顯示此標籤。
