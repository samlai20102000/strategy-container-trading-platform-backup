# 完整規劃：策略生命週期、部署流程、參數快照導入與下單執行

## 目錄

1. [系統架構概覽](#1-系統架構概覽)
2. [核心數據模型](#2-核心數據模型)
3. [完整工作流程](#3-完整工作流程)
4. [策略新建流程](#4-策略新建流程)
5. [參數快照導入流程](#5-參數快照導入流程)
6. [部署流程](#6-部署流程)
7. [下單執行流程](#7-下單執行流程)
8. [實施路線圖](#8-實施路線圖)

---

## 1. 系統架構概覽

### 1.1 整體架構圖

```
┌──────────────────────────────────────────────────────────────────────┐
│                        策略容器化自動交易平台                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 層級 1：策略配置層（Strategy Configuration Layer）          │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ • 新建策略（Strategy Trading）                             │    │
│  │ • 編輯策略參數（KAMA、馬丁、風控等）                        │    │
│  │ • 保存策略配置到數據庫                                       │    │
│  │ • 策略版本管理                                              │    │
│  │ • 策略複製、刪除                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              ↓                                        │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 層級 2：參數快照層（Parameter Snapshot Layer）              │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ • 保存策略配置快照                                          │    │
│  │ • 快照版本管理與標籤                                        │    │
│  │ • 快照導入（新建策略或更新現有策略）                        │    │
│  │ • 快照對比與回溯                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              ↓                                        │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 層級 3：部署創建層（Deployment Creation Layer）            │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ • 快速啟動面板（策略 + API Key + 交易對 + 模式）           │    │
│  │ • 部署配置驗證（Preflight）                                │    │
│  │ • 創建部署實例                                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              ↓                                        │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 層級 4：部署管理層（Deployment Management Layer）          │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ • 部署實例列表、搜尋、篩選                                  │    │
│  │ • 部署生命週期管理（啟動、暫停、停止）                      │    │
│  │ • 部署配置編輯（有限範圍）                                  │    │
│  │ • 運行日誌、性能指標                                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                              ↓                                        │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 層級 5：實盤執行層（Live Execution Layer）                 │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ • 信號生成（根據策略配置）                                  │    │
│  │ • 模式感知型信號驗證（S1/M2/H3）                           │    │
│  │ • 下單執行（開倉、加倉、平倉）                              │    │
│  │ • 持倉管理與狀態更新                                        │    │
│  │ • 執行日誌與審計                                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心模組關係

```
策略交易
  ├─ 新建策略 ──→ Strategy 表
  │               ├─ id, name, type, config, deploymentMode, ...
  │               └─ 不綁定 API Key、交易對
  │
  └─ 編輯策略 ──→ Strategy 表 (更新)
                  └─ 所有基於此策略的部署將使用新配置

參數快照庫
  ├─ 保存快照 ──→ StrategySnapshot 表
  │               ├─ id, strategyId, snapshotConfig, tags, ...
  │               └─ 快照是 Strategy 配置的時間點副本
  │
  ├─ 導入快照 ──→ Strategy 表 (新建或更新)
  │               └─ 根據快照恢復策略配置
  │
  └─ 快照對比 ──→ 顯示不同快照間的配置差異

部署工作台 - 快速啟動
  ├─ 選擇策略 ──→ 從 Strategy 表讀取
  ├─ 選擇 API Key ──→ 從 ApiKey 表讀取
  ├─ 選擇交易對 ──→ 從 Symbol 表讀取
  ├─ 選擇模式 ──→ S1/M2/H3
  └─ 啟動部署 ──→ Deployment 表 (新建)
                  ├─ strategyId, apiKeyId, symbol, deploymentMode, ...
                  └─ 綁定 API Key、交易對、模式

部署工作台 - 部署管理
  ├─ 列表部署 ──→ 從 Deployment 表讀取
  ├─ 編輯配置 ──→ Deployment 表 (更新部署特有參數)
  ├─ 生命週期管理 ──→ Deployment 表 (更新 status)
  └─ 查看日誌 ──→ 從 DeploymentLog 表讀取

實盤執行引擎
  ├─ 讀取部署配置 ──→ Deployment 表 + Strategy 表
  ├─ 生成信號 ──→ 根據 Strategy.config 生成
  ├─ 驗證信號 ──→ 根據 Deployment.deploymentMode 驗證
  ├─ 執行下單 ──→ 調用交易所 API
  └─ 記錄日誌 ──→ DeploymentLog 表
```

---

## 2. 核心數據模型

### 2.1 Strategy 表（策略配置表）

```typescript
interface Strategy {
  id: number;
  ownerId: string; // 所有者 ID
  name: string; // 策略名稱，例如 "KAMA 3K V6.1 高頻"
  type: 'KAMA_RAINBOW_MARTIN' | 'RAINBOW_TREND_LADDER' | ...; // 策略類型
  
  // 核心配置
  config: {
    // KAMA 參數
    kama: {
      fastPeriod: number; // 快線週期，例如 5
      slowPeriod: number; // 慢線週期，例如 34
      smoothingPeriod: number; // 平滑週期，例如 5
    };
    
    // 馬丁層級配置
    layerConfigs: Array<{
      layer: number; // 層級編號，例如 1, 2, 3, ...
      multiplier: number; // 倍數，例如 1.5, 1.1, 1.0
      stepPct: number; // 逐層間距百分比，例如 2%, 1.5%, ...
    }>;
    
    // 時間框架
    timeframe: '1m' | '5m' | '15m' | '30m' | '1h' | ...; // 例如 "30m"
    
    // 風控參數
    riskControl: {
      hardStop: number; // 極限止損，例如 3%
      protectionThreshold: number; // 保護門檻，例如 5%（H3 模式為 4%）
      maxLeverage: number; // 最大槓桿，例如 5
    };
    
    // 入場條件（可配置）
    entryConditions: {
      threeKEnabled: boolean; // 三 K 條件
      kamaFastSlowEnabled: boolean; // KAMA 快慢線交叉
      kamaDirectionLockEnabled: boolean; // KAMA 方向鎖
    };
    
    // 其他參數
    [key: string]: any;
  };
  
  // 部署模式預設
  deploymentMode: 'S1' | 'M2' | 'H3'; // 預設部署模式
  
  // 元數據
  createdAt: Date;
  updatedAt: Date;
  version: number; // 版本號，用於追蹤修改
  description?: string; // 策略描述
  tags?: string[]; // 標籤，例如 ["高頻", "馬丁"]
}
```

### 2.2 StrategySnapshot 表（參數快照表）

```typescript
interface StrategySnapshot {
  id: string; // 快照 ID，例如 "snapshot_20260801_120000"
  strategyId: number; // 關聯的策略 ID
  ownerId: string; // 所有者 ID
  
  // 快照配置（Strategy.config 的完整副本）
  snapshotConfig: Strategy['config'];
  
  // 快照元數據
  snapshotName: string; // 快照名稱，例如 "高頻回測優化版 v2"
  tags?: string[]; // 標籤，例如 ["回測優化", "高勝率"]
  description?: string; // 快照描述
  
  // 快照來源
  source: 'manual' | 'backtest' | 'deployment'; // 快照來源
  backtestId?: string; // 如果來自回測，記錄回測 ID
  deploymentId?: string; // 如果來自部署，記錄部署 ID
  
  // 快照性能指標（可選）
  performanceMetrics?: {
    totalProfit: number; // 總利潤
    winRate: number; // 勝率
    sharpeRatio: number; // 夏普比率
    maxDrawdown: number; // 最大回撤
    profitFactor: number; // 利潤因子
  };
  
  // 時間戳
  createdAt: Date;
  updatedAt: Date;
}
```

### 2.3 Deployment 表（部署實例表）

```typescript
interface Deployment {
  id: string; // 部署 ID，例如 "deployment_240004"
  ownerId: string; // 所有者 ID
  
  // 關聯信息
  strategyId: number; // 關聯的策略 ID
  apiKeyId: string; // 關聯的 API Key ID
  symbol: string; // 交易對，例如 "BTC-USDT"
  
  // 部署模式
  deploymentMode: 'S1' | 'M2' | 'H3'; // 部署模式
  
  // 部署特有配置
  deploymentConfig: {
    // 風控參數（可在部署層級覆蓋）
    riskControl?: {
      hardStop?: number;
      protectionThreshold?: number;
      maxLeverage?: number;
    };
    
    // 通知設置
    notifications?: {
      enableEmail: boolean;
      enableTelegram: boolean;
      enableWebhook: boolean;
    };
    
    // 其他部署特有參數
    [key: string]: any;
  };
  
  // 部署狀態
  status: 'DRAFT' | 'CREATED' | 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'BLOCKED' | 'ARCHIVED';
  
  // 運行信息
  activatedAt?: Date; // 啟動時間
  deactivatedAt?: Date; // 停用時間
  lastHealthCheckAt?: Date; // 最後健康檢查時間
  
  // 性能指標
  performanceMetrics?: {
    totalProfit: number;
    winRate: number;
    totalTrades: number;
    openPositions: number;
  };
  
  // 元數據
  createdAt: Date;
  updatedAt: Date;
  version: number; // 版本號，用於樂觀鎖
}
```

### 2.4 DeploymentLog 表（部署執行日誌表）

```typescript
interface DeploymentLog {
  id: string;
  deploymentId: string;
  
  // 日誌類型
  type: 'SIGNAL' | 'EXECUTION' | 'ERROR' | 'WARNING' | 'INFO' | 'MODE_DECISION';
  
  // 日誌內容
  message: string;
  details?: {
    signalId?: string;
    orderId?: string;
    reason?: string;
    error?: string;
    [key: string]: any;
  };
  
  // 時間戳
  timestamp: Date;
}
```

---

## 3. 完整工作流程

### 3.1 端到端流程圖

```
┌─────────────────────────────────────────────────────────────────────┐
│ 用戶操作流程                                                         │
└─────────────────────────────────────────────────────────────────────┘

選項 A：新建策略 → 部署 → 下單
  ↓
1. 進入策略交易模組
  ↓
2. 點擊「新增策略」
  ↓
3. 選擇策略類型（KAMA 3K V6.1）
  ↓
4. 配置策略參數
   ├─ KAMA 參數（快線 5、慢線 34 等）
   ├─ 馬丁層級（1-4×1.5, 5-9×1.1, 10-11×1.0）
   ├─ 時間框架（30m）
   ├─ 風控參數（極限止損 3%、保護門檻 5%）
   └─ 入場條件（三 K、KAMA 快慢線、方向鎖）
  ↓
5. 選擇部署模式預設（S1/M2/H3）
  ↓
6. 保存策略
  ↓
7. 進入部署工作台 - 快速啟動
  ↓
8. 選擇剛才保存的策略
  ↓
9. 選擇 API Key（OKX 帳戶）
  ↓
10. 選擇交易對（BTC-USDT）
  ↓
11. 選擇部署模式（M2 雙向獨立）
  ↓
12. 執行 Preflight 檢查
  ↓
13. 點擊「啟動部署」
  ↓
14. 部署已創建並運行中
  ↓
15. 實盤執行引擎開始生成信號與下單

選項 B：從參數快照導入 → 部署 → 下單
  ↓
1. 進入參數快照庫
  ↓
2. 瀏覽快照列表
  ↓
3. 選擇一個快照（例如「高頻回測優化版 v2」）
  ↓
4. 點擊「導入新策略」
  ↓
5. 快照配置自動填充到新策略表單
  ↓
6. 可選：微調參數
  ↓
7. 保存新策略
  ↓
8. 進入部署工作台 - 快速啟動
  ↓
9-15. 同上
```

---

## 4. 策略新建流程

### 4.1 UI 流程設計

**步驟 1：策略類型選擇**

```
┌─────────────────────────────────────────────────────────┐
│ 新增策略 - 步驟 1/5：選擇策略類型                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 選擇策略類型：                                          │
│ ┌─────────────────────────────────────────────────┐   │
│ │ ◉ KAMA 3K V6.1 高頻                             │   │
│ │   動態馬丁格爾策略，適合高頻交易                 │   │
│ │   推薦時間框架: 30m                             │   │
│ │                                                 │   │
│ │ ○ RAINBOW_TREND_LADDER                          │   │
│ │   彩虹趨勢階梯策略                               │   │
│ │   推薦時間框架: 1h                              │   │
│ │                                                 │   │
│ │ ○ ...                                            │   │
│ └─────────────────────────────────────────────────┘   │
│                                                         │
│ [上一步] [下一步]                                       │
└─────────────────────────────────────────────────────────┘
```

**步驟 2：策略參數配置**

```
┌─────────────────────────────────────────────────────────┐
│ 新增策略 - 步驟 2/5：配置策略參數                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 策略名稱：[KAMA 3K V6.1 高頻 - 版本 A]                 │
│                                                         │
│ KAMA 參數：                                             │
│ ├─ 快線週期: [5]                                        │
│ ├─ 慢線週期: [34]                                       │
│ └─ 平滑週期: [5]                                        │
│                                                         │
│ 時間框架：[▼ 30m]                                       │
│                                                         │
│ 馬丁層級配置：                                          │
│ ┌──────────────────────────────────────────────────┐  │
│ │ 層級 | 倍數  | 逐層間距 | 操作                    │  │
│ ├──────────────────────────────────────────────────┤  │
│ │ 1    | 1.5  | 2.0%   | [編輯] [刪除]            │  │
│ │ 2    | 1.5  | 1.5%   | [編輯] [刪除]            │  │
│ │ 3    | 1.5  | 1.5%   | [編輯] [刪除]            │  │
│ │ 4    | 1.5  | 1.5%   | [編輯] [刪除]            │  │
│ │ 5    | 1.1  | 1.0%   | [編輯] [刪除]            │  │
│ │ ...  | ...  | ...    | ...                      │  │
│ └──────────────────────────────────────────────────┘  │
│ [新增層級]                                              │
│                                                         │
│ [上一步] [下一步]                                       │
└─────────────────────────────────────────────────────────┘
```

**步驟 3：風控參數**

```
┌─────────────────────────────────────────────────────────┐
│ 新增策略 - 步驟 3/5：風控參數                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 極限止損 (Hard Stop): [3] %                             │
│ 說明: 單筆交易最大虧損百分比                             │
│                                                         │
│ 保護門檻: [5] %                                         │
│ 說明: 累積虧損達此百分比時觸發保護機制                   │
│                                                         │
│ 最大槓桿: [5] x                                         │
│ 說明: 單筆交易最大槓桿倍數                               │
│                                                         │
│ [上一步] [下一步]                                       │
└─────────────────────────────────────────────────────────┘
```

**步驟 4：入場條件**

```
┌─────────────────────────────────────────────────────────┐
│ 新增策略 - 步驟 4/5：入場條件                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 選擇入場條件（多選，AND 邏輯）：                        │
│                                                         │
│ ☑ 三 K 條件                                             │
│   說明: 三根 K 線的特定組合形態                         │
│                                                         │
│ ☑ KAMA 快慢線交叉                                       │
│   說明: 快線 > 慢線 = 做多，反之做空                    │
│                                                         │
│ ☐ KAMA 方向鎖                                           │
│   說明: 只在 KAMA 確認方向後才入場                      │
│                                                         │
│ [上一步] [下一步]                                       │
└─────────────────────────────────────────────────────────┘
```

**步驟 5：部署模式預設與保存**

```
┌─────────────────────────────────────────────────────────┐
│ 新增策略 - 步驟 5/5：部署模式預設                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 選擇部署模式預設：                                      │
│ ◉ S1 單倉互斥                                           │
│   同一時間只能有一個方向的持倉                           │
│                                                         │
│ ○ M2 雙向獨立                                           │
│   LONG 和 SHORT 可同時持倉，各自獨立管理                │
│                                                         │
│ ○ H3 保護對沖                                           │
│   主腿支持馬丁加倉，保護腿禁用馬丁                       │
│                                                         │
│ 策略描述（可選）：                                      │
│ [高頻交易策略，適合波動市場...]                         │
│                                                         │
│ 標籤（可選）：                                          │
│ [高頻] [馬丁] [動態]                                    │
│                                                         │
│ [上一步] [保存策略]                                     │
└─────────────────────────────────────────────────────────┘
```

### 4.2 後端實現邏輯

**創建策略 API（`server/routers.ts`）**

```typescript
createStrategy: protectedProcedure
  .input(z.object({
    name: z.string(),
    type: z.enum(['KAMA_RAINBOW_MARTIN', 'RAINBOW_TREND_LADDER', ...]),
    config: z.object({
      kama: z.object({
        fastPeriod: z.number(),
        slowPeriod: z.number(),
        smoothingPeriod: z.number(),
      }),
      layerConfigs: z.array(z.object({
        layer: z.number(),
        multiplier: z.number(),
        stepPct: z.number(),
      })),
      timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', ...]),
      riskControl: z.object({
        hardStop: z.number(),
        protectionThreshold: z.number(),
        maxLeverage: z.number(),
      }),
      entryConditions: z.object({
        threeKEnabled: z.boolean(),
        kamaFastSlowEnabled: z.boolean(),
        kamaDirectionLockEnabled: z.boolean(),
      }),
    }),
    deploymentMode: z.enum(['S1', 'M2', 'H3']),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    // 1. 驗證策略類型
    const strategyDef = STRATEGY_REGISTRY[input.type];
    if (!strategyDef) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown strategy type' });

    // 2. 驗證配置參數（例如層級編號必須連續）
    const validationResult = validateStrategyConfig(input.config, input.type);
    if (!validationResult.valid) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: validationResult.error });
    }

    // 3. 創建策略
    const strategy = await db.strategies.create({
      data: {
        ownerId: ctx.user.id,
        name: input.name,
        type: input.type,
        config: input.config,
        deploymentMode: input.deploymentMode,
        description: input.description,
        tags: input.tags,
        version: 1,
      },
    });

    return strategy;
  }),
```

---

## 5. 參數快照導入流程

### 5.1 UI 流程設計

**快照庫主頁面**

```
┌─────────────────────────────────────────────────────────┐
│ 參數快照庫                                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 搜尋: [_____________] 篩選: [全部] [高頻] [馬丁] [動態] │
│                                                         │
│ 快照列表：                                              │
│ ┌─────────────────────────────────────────────────┐   │
│ │ 高頻回測優化版 v2                                │   │
│ │ 策略: KAMA 3K V6.1 | 時間框架: 30m              │   │
│ │ 來源: 回測 | 日期: 2026-08-01 12:00             │   │
│ │ 性能: 利潤 +15.2% | 勝率 65% | 夏普 1.8         │   │
│ │ [導入新策略] [更新現有] [對比] [查看詳情]       │   │
│ └─────────────────────────────────────────────────┘   │
│                                                         │
│ ┌─────────────────────────────────────────────────┐   │
│ │ 保守型配置 v1                                    │   │
│ │ 策略: KAMA 3K V6.1 | 時間框架: 1h               │   │
│ │ 來源: 手動保存 | 日期: 2026-07-28 15:30         │   │
│ │ [導入新策略] [更新現有] [對比] [查看詳情]       │   │
│ └─────────────────────────────────────────────────┘   │
│                                                         │
│ (更多快照...)                                           │
└─────────────────────────────────────────────────────────┘
```

**導入新策略流程**

```
1. 在快照庫中點擊「導入新策略」
  ↓
2. 系統自動跳轉到策略交易模組
  ↓
3. 新增策略表單自動填充快照配置
  ├─ 策略類型：KAMA 3K V6.1
  ├─ KAMA 參數：快線 5、慢線 34 等
  ├─ 馬丁層級：1-4×1.5, 5-9×1.1, 10-11×1.0
  ├─ 時間框架：30m
  ├─ 風控參數：極限止損 3%、保護門檻 5%
  ├─ 入場條件：三 K、KAMA 快慢線、方向鎖
  └─ 部署模式預設：S1/M2/H3
  ↓
4. 用戶可選：微調參數
  ↓
5. 點擊「保存策略」
  ↓
6. 新策略已創建，可立即部署
```

**更新現有策略流程**

```
1. 在快照庫中點擊「更新現有」
  ↓
2. 彈出對話框，選擇要更新的策略
  ├─ 搜尋或篩選現有策略
  └─ 選擇目標策略
  ↓
3. 確認更新
  ├─ 顯示快照配置與現有策略的差異
  └─ 確認是否覆蓋
  ↓
4. 點擊「確認更新」
  ↓
5. 策略已更新，所有基於此策略的部署將使用新配置
```

**快照對比功能**

```
┌─────────────────────────────────────────────────────────┐
│ 快照對比：高頻回測優化版 v2 vs 保守型配置 v1            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 參數                 │ 高頻版 v2  │ 保守版 v1  │ 差異  │
│ ─────────────────────┼────────────┼────────────┼────── │
│ 快線週期             │ 5          │ 7          │ ↓ -2  │
│ 慢線週期             │ 34         │ 34         │ ✓ 相同│
│ 時間框架             │ 30m        │ 1h         │ ↓ 更短│
│ 層 1 倍數            │ 1.5        │ 1.2        │ ↑ +0.3│
│ 極限止損             │ 3%         │ 5%         │ ↓ -2% │
│ 保護門檻             │ 5%         │ 8%         │ ↓ -3% │
│                                                         │
│ [導入左邊] [導入右邊] [關閉]                             │
└─────────────────────────────────────────────────────────┘
```

### 5.2 後端實現邏輯

**導入快照為新策略 API**

```typescript
importSnapshotAsNewStrategy: protectedProcedure
  .input(z.object({
    snapshotId: z.string(),
    newStrategyName: z.string(),
    newStrategyDescription: z.string().optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    // 1. 查詢快照
    const snapshot = await db.strategySnapshots.findUnique({
      where: { id: input.snapshotId },
    });
    if (!snapshot) throw new TRPCError({ code: 'NOT_FOUND' });

    // 2. 驗證所有權
    if (snapshot.ownerId !== ctx.user.id) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }

    // 3. 創建新策略
    const newStrategy = await db.strategies.create({
      data: {
        ownerId: ctx.user.id,
        name: input.newStrategyName,
        type: snapshot.snapshotConfig.type, // 從快照中提取策略類型
        config: snapshot.snapshotConfig,
        deploymentMode: snapshot.snapshotConfig.deploymentMode || 'S1',
        description: input.newStrategyDescription,
        version: 1,
      },
    });

    // 4. 記錄來源
    await db.strategySnapshots.update({
      where: { id: input.snapshotId },
      data: {
        relatedStrategyId: newStrategy.id, // 可選：記錄關聯的策略
      },
    });

    return newStrategy;
  }),
```

---

## 6. 部署流程

### 6.1 完整部署流程圖

```
┌─────────────────────────────────────────────────────────┐
│ 部署工作台 - 快速啟動面板                                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ 步驟 1：選擇策略                                        │
│ [▼ 選擇策略...] ← 從 Strategy 表讀取                   │
│ 已選: KAMA 3K V6.1 高頻 (ID: 1)                        │
│                                                         │
│ 步驟 2：選擇 API Key                                    │
│ [▼ 選擇 API Key...] ← 從 ApiKey 表讀取                │
│ 已選: OKX 帳戶 (ID: 5)                                 │
│                                                         │
│ 步驟 3：選擇交易對                                      │
│ [▼ 選擇交易對...] ← 根據 API Key 動態載入              │
│ 已選: BTC-USDT                                         │
│                                                         │
│ 步驟 4：選擇部署模式                                    │
│ ◉ S1 單倉互斥  ○ M2 雙向獨立  ○ H3 保護對沖           │
│ 已選: M2                                               │
│                                                         │
│ 模式配置摘要：                                          │
│ ├─ 保護門檻: 5%                                        │
│ ├─ 馬丁倍率: 1-4×1.5, 5-9×1.1, 10-11×1.0             │
│ ├─ 時間框架: 30m                                       │
│ └─ 狀態: ✓ Preflight 通過                             │
│                                                         │
│ [微調配置] [啟動部署]                                   │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Preflight 檢查流程

```
Preflight 檢查清單
├─ 策略配置驗證
│  ├─ ✓ 策略類型有效
│  ├─ ✓ KAMA 參數在允許範圍內
│  ├─ ✓ 馬丁層級連續且有效
│  └─ ✓ 風控參數合理
├─ 部署配置驗證
│  ├─ ✓ API Key 有效且已授權
│  ├─ ✓ 交易對在交易所支持
│  ├─ ✓ 帳戶有足夠餘額
│  └─ ✓ 帳戶槓桿設置允許
├─ 模式特有驗證
│  ├─ (M2 模式) ✓ 腿級隔離規則有效
│  ├─ (H3 模式) ✓ 保護門檻正規化為 4%
│  └─ (H3 模式) ✓ 保護腿馬丁禁用規則有效
└─ 整體就緒檢查
   └─ ✓ 所有檢查通過，可以啟動部署
```

### 6.3 部署創建 API

```typescript
createDeployment: protectedProcedure
  .input(z.object({
    strategyId: z.number(),
    apiKeyId: z.string(),
    symbol: z.string(),
    deploymentMode: z.enum(['S1', 'M2', 'H3']),
    deploymentConfig: z.object({
      riskControl: z.object({
        hardStop: z.number().optional(),
        protectionThreshold: z.number().optional(),
        maxLeverage: z.number().optional(),
      }).optional(),
      notifications: z.object({
        enableEmail: z.boolean().optional(),
        enableTelegram: z.boolean().optional(),
        enableWebhook: z.boolean().optional(),
      }).optional(),
    }).optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    // 1. 驗證策略所有權
    const strategy = await db.strategies.findUnique({
      where: { id: input.strategyId, ownerId: ctx.user.id },
    });
    if (!strategy) throw new TRPCError({ code: 'NOT_FOUND' });

    // 2. 驗證 API Key 所有權
    const apiKey = await db.apiKeys.findUnique({
      where: { id: input.apiKeyId, ownerId: ctx.user.id },
    });
    if (!apiKey) throw new TRPCError({ code: 'NOT_FOUND' });

    // 3. 執行 Preflight 檢查
    const preflightResult = await deploymentLifecycle.checkPreflight({
      strategy,
      apiKey,
      symbol: input.symbol,
      deploymentMode: input.deploymentMode,
    });
    if (!preflightResult.passed) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Preflight failed: ${preflightResult.errors.join(', ')}`,
      });
    }

    // 4. 根據部署模式應用配置
    const modeConfig = getDeploymentModeConfig(input.deploymentMode, strategy);

    // 5. 創建部署
    const deployment = await db.deployments.create({
      data: {
        ownerId: ctx.user.id,
        strategyId: input.strategyId,
        apiKeyId: input.apiKeyId,
        symbol: input.symbol,
        deploymentMode: input.deploymentMode,
        deploymentConfig: {
          ...modeConfig,
          ...input.deploymentConfig,
        },
        status: 'CREATED',
      },
    });

    return deployment;
  }),
```

---

## 7. 下單執行流程

### 7.1 完整下單流程圖

```
┌──────────────────────────────────────────────────────────────┐
│ 實盤執行流程                                                  │
└──────────────────────────────────────────────────────────────┘

1. Heartbeat 排程觸發（每分鐘）
  ↓
2. 查詢所有活躍部署
  ├─ 從 Deployment 表讀取 status = 'ACTIVE'
  └─ 獲取關聯的 Strategy 配置
  ↓
3. 對每個部署執行信號生成
  ├─ 根據 Strategy.config 生成信號
  ├─ 信號包含：action (BUY/SELL/CLOSE)、side (long/short)、price 等
  └─ 記錄信號到 DeploymentLog
  ↓
4. 模式感知型信號驗證
  ├─ S1 模式: 檢查單倉互斥規則
  ├─ M2 模式: 檢查腿級隔離規則
  └─ H3 模式: 檢查保護腿邏輯
  ↓
5. 執行下單
  ├─ 調用交易所 API（OKX）
  ├─ 下單類型：開倉、加倉、平倉
  └─ 記錄訂單 ID 到 DeploymentLog
  ↓
6. 持倉狀態更新
  ├─ 查詢交易所持倉
  ├─ 更新本地持倉狀態
  └─ 計算性能指標
  ↓
7. 日誌與審計
  ├─ 記錄所有決策到 DeploymentLog
  ├─ 記錄執行結果（成功/失敗）
  └─ 觸發通知（如配置）
```

### 7.2 信號生成邏輯

**KAMA 3K V6.1 信號生成**

```typescript
async function generateSignalForKAMA(deployment: Deployment, strategy: Strategy) {
  const { symbol, deploymentMode } = deployment;
  const { config } = strategy;

  // 1. 獲取最新 K 線數據
  const klines = await getKlines(symbol, config.timeframe, 100);

  // 2. 計算 KAMA 指標
  const kama = calculateKAMA(klines, config.kama);

  // 3. 檢查入場條件
  const conditionsMet = [];

  if (config.entryConditions.threeKEnabled) {
    const threeKSignal = checkThreeKPattern(klines);
    if (threeKSignal) conditionsMet.push('threeK');
  }

  if (config.entryConditions.kamaFastSlowEnabled) {
    const fastSlowSignal = checkKAMAFastSlowCrossover(kama);
    if (fastSlowSignal) conditionsMet.push('kamaFastSlow');
  }

  if (config.entryConditions.kamaDirectionLockEnabled) {
    const directionLock = checkKAMADirectionLock(kama);
    if (directionLock) conditionsMet.push('kamaDirectionLock');
  }

  // 4. 判斷是否所有條件都滿足（AND 邏輯）
  const enabledConditions = Object.entries(config.entryConditions)
    .filter(([_, enabled]) => enabled)
    .map(([key, _]) => key.replace('Enabled', ''));

  const allConditionsMet = enabledConditions.every(cond => conditionsMet.includes(cond));

  if (!allConditionsMet) {
    return null; // 沒有信號
  }

  // 5. 確定交易方向
  const direction = determineDirection(klines, kama, config.entryConditions);

  // 6. 生成信號
  const signal = {
    action: 'BUY' | 'SELL' | 'CLOSE',
    side: direction, // 'long' or 'short'
    price: klines[klines.length - 1].close,
    timestamp: new Date(),
    reason: `Conditions met: ${conditionsMet.join(', ')}`,
  };

  return signal;
}
```

### 7.3 模式感知型執行邏輯

**S1 模式執行**

```typescript
async function executeSignalS1(signal: Signal, deployment: Deployment) {
  const { symbol, deploymentMode } = deployment;

  // 1. 查詢現有持倉
  const positions = await getPositions(deployment.apiKeyId, symbol);

  // 2. S1 規則：同一時間只能有一個方向的持倉
  if (positions.length > 0 && positions[0].side !== signal.side) {
    // 先平倉現有持倉
    await closePosition(deployment, positions[0]);
    await logDecision(deployment, {
      action: 'CLOSE',
      reason: 'S1 mode: closing opposite position before new entry',
    });
  }

  // 3. 執行新信號
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    const order = await placeOrder(deployment, signal);
    await logDecision(deployment, {
      action: signal.action,
      orderId: order.id,
      reason: 'S1 mode: new entry',
    });
  }
}
```

**M2 模式執行**

```typescript
async function executeSignalM2(signal: Signal, deployment: Deployment) {
  const { symbol, deploymentMode } = deployment;

  // 1. 識別信號所屬的腿
  const legId = identifyLeg(signal, deployment.deploymentConfig);

  // 2. 查詢該腿的現有持倉
  const legPositions = await getPositionsForLeg(deployment, legId);

  // 3. M2 規則：每條腿獨立管理
  if (legPositions.length > 0 && legPositions[0].side !== signal.side) {
    // 先平倉該腿的相反方向持倉
    for (const pos of legPositions) {
      await closePosition(deployment, pos);
    }
    await logDecision(deployment, {
      action: 'CLOSE',
      legId,
      reason: 'M2 mode: closing opposite position in leg before new entry',
    });
  }

  // 4. 執行新信號
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    const order = await placeOrder(deployment, signal);
    await logDecision(deployment, {
      action: signal.action,
      legId,
      orderId: order.id,
      reason: 'M2 mode: new entry in leg',
    });
  }
}
```

**H3 模式執行**

```typescript
async function executeSignalH3(signal: Signal, deployment: Deployment) {
  const { symbol, deploymentMode } = deployment;

  // 1. 識別信號所屬的腿（主腿或保護腿）
  const legType = identifyLegType(signal, deployment.deploymentConfig);

  // 2. 查詢該腿的現有持倉
  const legPositions = await getPositionsForLeg(deployment, legType);

  if (legType === 'main') {
    // 主腿：支持馬丁加倉
    if (signal.action === 'BUY' || signal.action === 'SELL') {
      const order = await placeOrder(deployment, signal);
      await logDecision(deployment, {
        action: signal.action,
        legType: 'main',
        orderId: order.id,
        reason: 'H3 mode: main leg entry/add',
      });
    }
  } else if (legType === 'protection') {
    // 保護腿：禁用馬丁加倉
    if (signal.action === 'BUY' || signal.action === 'SELL') {
      if (legPositions.length === 0) {
        // 開倉（不支持加倉）
        const order = await placeOrder(deployment, signal);
        await logDecision(deployment, {
          action: signal.action,
          legType: 'protection',
          orderId: order.id,
          reason: 'H3 mode: protection leg entry (no martin)',
        });
      } else {
        // 已有持倉，不執行加倉
        await logDecision(deployment, {
          action: signal.action,
          legType: 'protection',
          skipped: true,
          reason: 'H3 mode: protection leg martin disabled',
        });
      }
    }
  }

  // 3. 檢查保護門檻（H3 模式下為 4%，其他模式為 5%）
  const protectionThreshold = strategy.key === 'KAMA_RAINBOW_MARTIN' ? 4 : 5;
  const currentDrawdown = await calculateDrawdown(deployment);
  if (currentDrawdown >= protectionThreshold) {
    // 觸發保護機制，平倉所有持倉
    await closeAllPositions(deployment);
    await logDecision(deployment, {
      action: 'CLOSE_ALL',
      reason: `H3 mode: protection threshold ${protectionThreshold}% triggered`,
    });
  }
}
```

### 7.4 下單執行 API

```typescript
async function placeOrder(deployment: Deployment, signal: Signal) {
  const { apiKeyId, symbol, deploymentMode } = deployment;
  const { strategy } = deployment;

  // 1. 計算訂單數量
  const quantity = calculateOrderQuantity(deployment, signal);

  // 2. 構建訂單請求
  const orderRequest = {
    symbol,
    side: signal.side,
    type: 'MARKET', // 或 'LIMIT'
    quantity,
    // ... 其他訂單參數
  };

  // 3. 調用交易所 API
  const order = await exchangeAdapter.placeOrder(apiKeyId, orderRequest);

  // 4. 記錄訂單
  await db.deploymentLogs.create({
    data: {
      deploymentId: deployment.id,
      type: 'EXECUTION',
      message: `Order placed: ${signal.side} ${quantity} @ ${signal.price}`,
      details: {
        orderId: order.id,
        quantity,
        price: signal.price,
      },
    },
  });

  return order;
}
```

---

## 8. 實施路線圖

### 8.1 分階段實施計劃

| 階段 | 任務 | 工作量 | 優先級 |
|------|------|--------|--------|
| 1 | 數據模型設計與數據庫遷移 | 8h | P0 |
| 2 | 策略新建流程（UI + 後端） | 12h | P0 |
| 3 | 參數快照導入流程（UI + 後端） | 10h | P1 |
| 4 | 部署工作台重構（快速啟動 + 部署管理） | 15h | P0 |
| 5 | Preflight 檢查實現 | 8h | P0 |
| 6 | 實盤執行引擎（S1/M2/H3） | 20h | P0 |
| 7 | 下單執行與持倉管理 | 12h | P0 |
| 8 | 日誌、監控與通知 | 10h | P1 |
| 9 | 完整測試與驗證 | 10h | P0 |
| **總計** | | **105h** | |

### 8.2 里程碑

- **里程碑 1（第 1-2 週）**：完成策略新建、參數快照導入、部署工作台重構
- **里程碑 2（第 3 週）**：完成 Preflight 檢查、實盤執行引擎
- **里程碑 3（第 4 週）**：完成下單執行、日誌監控、完整測試

---

## 9. 總結

本文檔提供了一個完整的、軍工級的端到端規劃，涵蓋：

1. **策略生命週期**：從新建到編輯、保存、版本管理
2. **參數快照導入**：快照保存、導入、對比、恢復
3. **部署流程**：快速啟動、Preflight 檢查、部署創建
4. **下單執行**：信號生成、模式驗證、下單執行、持倉管理

所有設計均遵循清晰的層級分離、功能邊界明確、數據流向清晰的原則，確保系統的可維護性、可擴展性與可靠性。

