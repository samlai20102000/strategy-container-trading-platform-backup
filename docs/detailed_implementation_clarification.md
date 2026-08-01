# S1/M2/H3 完全集成方案：三個關鍵問題的深度優化設計

## 問題 1：策略交易卡片實時切換 S1/M2/H3 模式

### 1.1 現有問題分析

當前設計中，Preflight 與生命週期被設計為獨立的功能鍵，這導致用戶需要離開策略卡片才能進行模式管理。這種設計在實際操作中會造成上下文切換頻繁，降低工作效率。

### 1.2 優化方案：策略卡片內嵌模式切換器

**核心設計理念**：將 S1/M2/H3 模式切換集成到策略卡片本身，使其成為卡片的一個核心操作元素，而非獨立功能鍵。

#### 1.2.1 UI/UX 設計

**策略卡片佈局重構**：

```
┌─────────────────────────────────────────────────────────┐
│  策略名稱 (KAMA 3K V6.1 高頻)                 [編輯] [刪除]│
├─────────────────────────────────────────────────────────┤
│  交易對: BTC-USDT | 槓桿: 5x | 方向: 雙向              │
├─────────────────────────────────────────────────────────┤
│  部署模式選擇 (實時切換)                                 │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ◉ S1 單倉互斥  ○ M2 雙向獨立  ○ H3 保護對沖     │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  當前模式配置摘要:                                       │
│  ├─ 保護門檻: 4%                                        │
│  ├─ 馬丁倍率: 1-4×1.5, 5-9×1.1, 10-11×1.0             │
│  ├─ 時間框架: 30m                                       │
│  └─ 狀態: ✓ Preflight 通過                             │
├─────────────────────────────────────────────────────────┤
│  快速操作:                                              │
│  [啟動部署] [暫停] [停止] [查看日誌] [回測此配置]       │
└─────────────────────────────────────────────────────────┘
```

**關鍵特性**：

1. **模式選擇器**：使用 Radio Button 或 Segmented Control 實現三模式快速切換。
   - 每個選項旁邊應有簡潔的說明文字（例如 S1 = 單倉互斥）。
   - 選擇不同模式時，卡片下方的「當前模式配置摘要」應即時更新。

2. **當前模式配置摘要**：
   - 顯示該模式下的關鍵參數（保護門檻、馬丁倍率、時間框架等）。
   - 如果配置不完整或存在問題，應顯示警告徽章（⚠️）。
   - 點擊摘要區域可展開完整配置詳情（modal 或 drawer）。

3. **Preflight 狀態指示**：
   - 在模式配置摘要下方顯示 Preflight 檢查結果。
   - 如果 Preflight 未通過，應顯示具體的失敗原因與修復建議。

4. **快速操作按鈕**：
   - 保留現有的啟動、暫停、停止按鈕。
   - 新增「查看日誌」按鈕，快速查看該策略的實盤執行日誌。
   - 新增「回測此配置」按鈕，快速跳轉到回測中心並預填當前策略與模式配置。

#### 1.2.2 實時切換的技術實現

**前端邏輯（`client/src/pages/Strategies.tsx`）**：

```typescript
// 策略卡片組件中的模式切換邏輯
const [selectedMode, setSelectedMode] = useState<'S1' | 'M2' | 'H3'>(strategy.deploymentMode || 'S1');
const [configSummary, setConfigSummary] = useState(null);
const [preflightStatus, setPreflightStatus] = useState(null);

// 當模式改變時，立即更新配置摘要與 Preflight 狀態
useEffect(() => {
  // 1. 根據新模式生成配置摘要
  const summary = generateConfigSummary(strategy, selectedMode);
  setConfigSummary(summary);

  // 2. 異步調用後端 Preflight API
  trpc.deployments.checkPreflight.useQuery({
    strategyId: strategy.id,
    deploymentMode: selectedMode,
  }).then(result => {
    setPreflightStatus(result);
  });
}, [selectedMode]);

// 保存模式選擇到數據庫（可選：自動保存或點擊保存按鈕）
const handleModeChange = async (newMode: 'S1' | 'M2' | 'H3') => {
  setSelectedMode(newMode);
  
  // 自動保存到數據庫（或等待用戶點擊保存按鈕）
  await trpc.strategies.updateDeploymentMode.useMutation({
    strategyId: strategy.id,
    deploymentMode: newMode,
  });
};
```

**後端邏輯（`server/routers.ts`）**：

```typescript
// 新增 updateDeploymentMode 路由
updateDeploymentMode: protectedProcedure
  .input(z.object({
    strategyId: z.number(),
    deploymentMode: z.enum(['S1', 'M2', 'H3']),
  }))
  .mutation(async ({ ctx, input }) => {
    // 1. 驗證策略所有權
    const strategy = await db.strategies.findUnique({
      where: { id: input.strategyId, ownerId: ctx.user.id },
    });
    if (!strategy) throw new TRPCError({ code: 'NOT_FOUND' });

    // 2. 根據新模式應用相應的預設配置
    const modeConfig = getDeploymentModeConfig(input.deploymentMode, strategy);

    // 3. 更新策略配置
    const updated = await db.strategies.update({
      where: { id: input.strategyId },
      data: {
        deploymentMode: input.deploymentMode,
        config: modeConfig,
      },
    });

    return updated;
  }),

// 新增 checkPreflight 查詢路由
checkPreflight: protectedProcedure
  .input(z.object({
    strategyId: z.number(),
    deploymentMode: z.enum(['S1', 'M2', 'H3']),
  }))
  .query(async ({ ctx, input }) => {
    const strategy = await db.strategies.findUnique({
      where: { id: input.strategyId, ownerId: ctx.user.id },
    });
    if (!strategy) throw new TRPCError({ code: 'NOT_FOUND' });

    // 執行 Preflight 檢查
    const result = await deploymentLifecycle.checkPreflight({
      strategy,
      deploymentMode: input.deploymentMode,
    });

    return result;
  }),
```

#### 1.2.3 模式配置的自動應用

當用戶切換模式時，系統應自動應用該模式的預設配置，並根據需要調整策略參數。例如：

- **S1 模式**：單倉互斥，禁用馬丁加倉，保護門檻 = 5%（通用預設）。
- **M2 模式**：雙向獨立，啟用馬丁加倉，腿級隔離，保護門檻 = 5%。
- **H3 模式**：保護對沖，啟用馬丁加倉，保護腿禁用馬丁，保護門檻 = 4%（KRM 專用）。

```typescript
// 根據部署模式生成配置
function getDeploymentModeConfig(mode: 'S1' | 'M2' | 'H3', strategy: Strategy) {
  const baseConfig = strategy.config;

  switch (mode) {
    case 'S1':
      return {
        ...baseConfig,
        deploymentMode: 'S1',
        martinEnabled: false,
        protectionThreshold: 5,
      };
    case 'M2':
      return {
        ...baseConfig,
        deploymentMode: 'M2',
        martinEnabled: true,
        legIsolation: true,
        protectionThreshold: 5,
      };
    case 'H3':
      return {
        ...baseConfig,
        deploymentMode: 'H3',
        martinEnabled: true,
        protectionLegMartinDisabled: true,
        protectionThreshold: strategy.key === 'KAMA_RAINBOW_MARTIN' ? 4 : 5,
      };
  }
}
```

#### 1.2.4 軍工級 UI 細節

- **視覺反饋**：當用戶切換模式時，卡片應有輕微的淡入淡出動畫，表示配置正在更新。
- **錯誤提示**：如果模式切換失敗，應在卡片上方顯示紅色的錯誤提示，並提供重試選項。
- **狀態徽章**：在卡片右上角顯示當前模式的徽章（例如 S1、M2、H3），顏色區分。
- **響應式設計**：在行動設備上，模式選擇器應改為下拉選單，以節省空間。

---

## 問題 2：部署工作台雙面板重構的具體操作

### 2.1 現有問題分析

當前部署工作台是一個單面板設計，用戶需要在「部署列表」和「部署詳情」之間頻繁切換。這導致工作流不連貫，特別是在啟動新部署時，用戶需要先建立部署，然後再手動啟動，流程繁瑣。

### 2.2 優化方案：「部署管理」+「快速啟動」雙面板

#### 2.2.1 整體佈局設計

```
┌─────────────────────────────────────────────────────────────────────┐
│  三模式部署工作台                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─ 部署管理面板 ────────────┐  ┌─ 快速啟動面板 ────────────────┐  │
│  │                            │  │                               │  │
│  │ 搜尋: [_____________]      │  │ 策略選擇:                     │  │
│  │ 篩選: [全部] [S1] [M2][H3] │  │ [▼ 選擇策略...]              │  │
│  │                            │  │                               │  │
│  │ 部署列表:                  │  │ API Key:                      │  │
│  │ ┌──────────────────────┐  │  │ [▼ 選擇 API Key...]           │  │
│  │ │ M2-雙向獨立          │  │  │                               │  │
│  │ │ Kama 3K V6.1高頻    │  │  │ 交易對:                       │  │
│  │ │ #240004 · BTCUSDT   │  │  │ [▼ 選擇交易對...]             │  │
│  │ │ 預檢封印 | 編輯配置  │  │  │                               │  │
│  │ │ [複製] [停用] [刪除] │  │  │ 部署模式:                     │  │
│  │ └──────────────────────┘  │  │ ◉ S1 ○ M2 ○ H3              │  │
│  │                            │  │                               │  │
│  │ ┌──────────────────────┐  │  │ 模式配置摘要:                 │  │
│  │ │ S1-單倉互斥          │  │  │ ├─ 保護門檻: 4%              │  │
│  │ │ V4.0 KAMA+3K 動態馬丁│  │  │ ├─ 馬丁倍率: 1-4×1.5...      │  │
│  │ │ #120011 · BTCUSDT   │  │  │ ├─ 時間框架: 30m             │  │
│  │ │ 運行中 | 編輯配置    │  │  │ └─ 狀態: ✓ Preflight 通過    │  │
│  │ │ [複製] [暫停] [刪除] │  │  │                               │  │
│  │ └──────────────────────┘  │  │ [微調配置] [啟動部署]         │  │
│  │                            │  │                               │  │
│  │ (更多部署...)              │  │ 快速操作:                     │  │
│  │                            │  │ [回測此配置] [查看範本]       │  │
│  │                            │  │                               │  │
│  └────────────────────────────┘  └───────────────────────────────┘  │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

#### 2.2.2 「部署管理」面板詳細設計

**功能**：

1. **搜尋與篩選**：
   - 搜尋框：按部署名稱、策略名稱或交易對搜尋。
   - 篩選按鈕：按部署模式（S1/M2/H3）或狀態（運行中、暫停、停用、已封存）篩選。

2. **部署卡片**：
   - 顯示部署的基本信息（模式、策略名稱、交易對、狀態）。
   - 狀態徽章：用顏色區分不同狀態（綠色=運行中，黃色=暫停，灰色=停用，藍色=已封存）。
   - 快速操作按鈕：複製、暫停/恢復、停用、刪除。
   - 「編輯配置」按鈕：點擊後展開詳情面板或打開 modal，允許用戶修改部署配置。
   - 「預檢」按鈕：點擊後執行 Preflight 檢查，並顯示結果。

3. **部署詳情面板**（可選，點擊卡片展開）：
   - 顯示完整的部署配置（策略參數、模式特有參數等）。
   - 顯示部署的運行歷史、日誌、性能指標等。
   - 提供編輯、複製、刪除等操作。

#### 2.2.3 「快速啟動」面板詳細設計

**功能**：

1. **策略選擇器**：
   - 下拉選單，列出所有可用策略（V4.0、V6.1 等）。
   - 選擇策略後，自動載入該策略的預設配置。

2. **API Key 選擇器**：
   - 下拉選單，列出所有已配置的 API Key。
   - 選擇 API Key 後，自動載入該 API Key 對應的交易所與帳戶信息。

3. **交易對選擇器**：
   - 下拉選單，根據所選 API Key 的交易所動態載入可用交易對。
   - 支援搜尋與收藏功能。

4. **部署模式選擇器**：
   - Radio Button 或 Segmented Control，選擇 S1/M2/H3。
   - 選擇模式後，自動載入該模式的預設配置。

5. **模式配置摘要**：
   - 顯示當前所選模式的關鍵參數。
   - 點擊「微調配置」按鈕，打開 modal 允許用戶調整參數。

6. **快速操作**：
   - 「啟動部署」按鈕：點擊後創建新部署並立即啟動。
   - 「回測此配置」按鈕：跳轉到回測中心，預填當前選擇的策略、模式及配置。
   - 「查看範本」按鈕：顯示該策略的推薦配置範本。

#### 2.2.4 實現細節

**前端佈局（`client/src/pages/DeploymentWorkbench.tsx`）**：

```typescript
export function DeploymentWorkbench() {
  const [selectedMode, setSelectedMode] = useState<'S1' | 'M2' | 'H3'>('S1');
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [selectedApiKey, setSelectedApiKey] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  return (
    <div className="flex gap-6 p-6">
      {/* 部署管理面板 */}
      <div className="flex-1 border rounded-lg p-4">
        <DeploymentManagementPanel />
      </div>

      {/* 快速啟動面板 */}
      <div className="flex-1 border rounded-lg p-4">
        <QuickLaunchPanel
          onModeChange={setSelectedMode}
          onStrategyChange={setSelectedStrategy}
          onApiKeyChange={setSelectedApiKey}
          onSymbolChange={setSelectedSymbol}
        />
      </div>
    </div>
  );
}

// 部署管理面板組件
function DeploymentManagementPanel() {
  const { data: deployments } = trpc.deployments.list.useQuery();
  const [searchTerm, setSearchTerm] = useState('');
  const [modeFilter, setModeFilter] = useState<'all' | 'S1' | 'M2' | 'H3'>('all');

  const filtered = deployments?.filter(d => {
    const matchesSearch = d.name.includes(searchTerm) || d.strategyName.includes(searchTerm);
    const matchesMode = modeFilter === 'all' || d.deploymentMode === modeFilter;
    return matchesSearch && matchesMode;
  }) || [];

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">部署管理</h2>
      
      {/* 搜尋與篩選 */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="搜尋部署..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full px-3 py-2 border rounded"
        />
        <div className="flex gap-2 mt-2">
          {['all', 'S1', 'M2', 'H3'].map(mode => (
            <button
              key={mode}
              onClick={() => setModeFilter(mode as any)}
              className={`px-3 py-1 rounded ${
                modeFilter === mode ? 'bg-blue-500 text-white' : 'bg-gray-200'
              }`}
            >
              {mode === 'all' ? '全部' : mode}
            </button>
          ))}
        </div>
      </div>

      {/* 部署列表 */}
      <div className="space-y-3">
        {filtered.map(deployment => (
          <DeploymentCard key={deployment.id} deployment={deployment} />
        ))}
      </div>
    </div>
  );
}

// 快速啟動面板組件
function QuickLaunchPanel({ onModeChange, onStrategyChange, onApiKeyChange, onSymbolChange }) {
  const [selectedMode, setSelectedMode] = useState<'S1' | 'M2' | 'H3'>('S1');
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [selectedApiKey, setSelectedApiKey] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [configSummary, setConfigSummary] = useState(null);

  const { data: strategies } = trpc.registry.listDefinitions.useQuery();
  const { data: apiKeys } = trpc.apiKeys.list.useQuery();
  const { data: symbols } = trpc.exchanges.getSymbols.useQuery(
    { apiKeyId: selectedApiKey },
    { enabled: !!selectedApiKey }
  );

  // 當模式或策略改變時，更新配置摘要
  useEffect(() => {
    if (selectedStrategy && selectedMode) {
      const summary = generateConfigSummary(selectedStrategy, selectedMode);
      setConfigSummary(summary);
    }
  }, [selectedStrategy, selectedMode]);

  const handleLaunchDeployment = async () => {
    const result = await trpc.deployments.create.useMutation({
      strategyId: selectedStrategy,
      apiKeyId: selectedApiKey,
      symbol: selectedSymbol,
      deploymentMode: selectedMode,
    });

    if (result.success) {
      // 立即啟動部署
      await trpc.deployments.activate.useMutation({
        deploymentId: result.data.id,
      });
      // 顯示成功提示
      toast.success('部署已啟動');
    }
  };

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">快速啟動</h2>

      {/* 策略選擇 */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">策略選擇</label>
        <select
          value={selectedStrategy || ''}
          onChange={e => {
            setSelectedStrategy(e.target.value);
            onStrategyChange(e.target.value);
          }}
          className="w-full px-3 py-2 border rounded"
        >
          <option value="">選擇策略...</option>
          {strategies?.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* API Key 選擇 */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">API Key</label>
        <select
          value={selectedApiKey || ''}
          onChange={e => {
            setSelectedApiKey(e.target.value);
            onApiKeyChange(e.target.value);
          }}
          className="w-full px-3 py-2 border rounded"
        >
          <option value="">選擇 API Key...</option>
          {apiKeys?.map(k => (
            <option key={k.id} value={k.id}>{k.name}</option>
          ))}
        </select>
      </div>

      {/* 交易對選擇 */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">交易對</label>
        <select
          value={selectedSymbol || ''}
          onChange={e => {
            setSelectedSymbol(e.target.value);
            onSymbolChange(e.target.value);
          }}
          className="w-full px-3 py-2 border rounded"
          disabled={!selectedApiKey}
        >
          <option value="">選擇交易對...</option>
          {symbols?.map(s => (
            <option key={s.id} value={s.symbol}>{s.symbol}</option>
          ))}
        </select>
      </div>

      {/* 部署模式選擇 */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">部署模式</label>
        <div className="flex gap-3">
          {['S1', 'M2', 'H3'].map(mode => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="deploymentMode"
                value={mode}
                checked={selectedMode === mode}
                onChange={e => {
                  setSelectedMode(e.target.value as any);
                  onModeChange(e.target.value as any);
                }}
              />
              <span>{mode}</span>
            </label>
          ))}
        </div>
      </div>

      {/* 模式配置摘要 */}
      {configSummary && (
        <div className="mb-4 p-3 bg-gray-100 rounded text-sm">
          <h3 className="font-bold mb-2">模式配置摘要</h3>
          <ul className="space-y-1">
            <li>保護門檻: {configSummary.protectionThreshold}%</li>
            <li>馬丁倍率: {configSummary.martinMultipliers}</li>
            <li>時間框架: {configSummary.timeframe}</li>
            <li>狀態: {configSummary.preflightStatus}</li>
          </ul>
        </div>
      )}

      {/* 快速操作 */}
      <div className="space-y-2">
        <button
          onClick={handleLaunchDeployment}
          disabled={!selectedStrategy || !selectedApiKey || !selectedSymbol}
          className="w-full px-4 py-2 bg-blue-500 text-white rounded disabled:bg-gray-300"
        >
          啟動部署
        </button>
        <button
          onClick={() => {/* 跳轉到回測中心 */}}
          className="w-full px-4 py-2 bg-gray-500 text-white rounded"
        >
          回測此配置
        </button>
      </div>
    </div>
  );
}
```

---

## 問題 3：實盤執行自動化的具體操作

### 3.1 現有問題分析

當前實盤執行引擎可能沒有充分考慮部署模式的差異，導致 S1/M2/H3 模式下的策略行為不一致。用戶需要清楚地了解實盤執行時系統如何自動應用部署模式的配置。

### 3.2 優化方案：部署模式感知型執行引擎

#### 3.2.1 執行流程架構

```
┌─────────────────────────────────────────────────────────────┐
│ 實盤執行流程                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ 1. 信號接收 (Webhook / 自動交易)                             │
│    ↓                                                         │
│ 2. 部署查詢                                                  │
│    ├─ 根據 deploymentId 查詢部署配置                        │
│    ├─ 提取 deploymentMode (S1/M2/H3)                        │
│    └─ 提取策略 ID 與完整配置                                │
│    ↓                                                         │
│ 3. 模式感知型信號驗證                                        │
│    ├─ S1 模式: 檢查單倉互斥規則                             │
│    ├─ M2 模式: 檢查腿級隔離規則                             │
│    └─ H3 模式: 檢查保護腿邏輯                               │
│    ↓                                                         │
│ 4. 策略執行引擎                                              │
│    ├─ 根據 deploymentMode 選擇執行邏輯                      │
│    ├─ 應用模式特有的風控規則                                │
│    └─ 執行下單、加倉、平倉等操作                            │
│    ↓                                                         │
│ 5. 持倉狀態更新                                              │
│    ├─ 更新模式特有的持倉狀態                                │
│    ├─ 記錄模式決策日誌                                      │
│    └─ 觸發相應的通知與警報                                  │
│    ↓                                                         │
│ 6. 實盤執行完成                                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

#### 3.2.2 模式特有的執行邏輯

**S1 模式（單倉互斥）**：

```typescript
async function executeSignalS1(signal: Signal, deployment: Deployment) {
  const { strategy, config, deploymentMode } = deployment;

  // 1. 檢查現有持倉
  const existingPositions = await getPositions(deployment.apiKeyId, config.symbol);

  // 2. S1 模式規則：同一時間只能有一個方向的持倉
  if (existingPositions.length > 0 && existingPositions[0].side !== signal.side) {
    // 先平倉現有持倉
    await closePosition(deployment, existingPositions[0]);
  }

  // 3. 執行新信號（開倉或加倉）
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    await executeOpenOrAdd(signal, deployment, config);
  } else if (signal.action === 'CLOSE') {
    await closePosition(deployment, existingPositions[0]);
  }

  // 4. 記錄模式決策日誌
  await logModeDecision({
    deploymentId: deployment.id,
    deploymentMode: 'S1',
    action: signal.action,
    reason: 'S1 模式：單倉互斥',
  });
}
```

**M2 模式（雙向獨立）**：

```typescript
async function executeSignalM2(signal: Signal, deployment: Deployment) {
  const { strategy, config, deploymentMode } = deployment;

  // 1. 識別信號所屬的腿（Leg）
  const legId = identifyLeg(signal, config);

  // 2. 檢查該腿的現有持倉
  const legPositions = await getPositionsForLeg(deployment, legId);

  // 3. M2 模式規則：每條腿獨立管理，支持多方向持倉
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    // 檢查該腿是否已有相反方向的持倉
    const oppositePositions = legPositions.filter(p => p.side !== signal.side);
    if (oppositePositions.length > 0) {
      // 先平倉相反方向的持倉
      for (const pos of oppositePositions) {
        await closePosition(deployment, pos);
      }
    }

    // 執行新信號
    await executeOpenOrAdd(signal, deployment, config, legId);
  } else if (signal.action === 'CLOSE') {
    // 平倉該腿的所有持倉
    for (const pos of legPositions) {
      await closePosition(deployment, pos);
    }
  }

  // 4. 記錄模式決策日誌
  await logModeDecision({
    deploymentId: deployment.id,
    deploymentMode: 'M2',
    legId,
    action: signal.action,
    reason: 'M2 模式：腿級隔離',
  });
}
```

**H3 模式（保護對沖）**：

```typescript
async function executeSignalH3(signal: Signal, deployment: Deployment) {
  const { strategy, config, deploymentMode } = deployment;

  // 1. 識別信號所屬的腿（主腿或保護腿）
  const legType = identifyLegType(signal, config); // 'main' or 'protection'

  // 2. 檢查該腿的現有持倉
  const legPositions = await getPositionsForLeg(deployment, legType);

  // 3. H3 模式規則：主腿支持馬丁加倉，保護腿禁用馬丁
  if (legType === 'main') {
    // 主腿：支持馬丁加倉
    if (signal.action === 'BUY' || signal.action === 'SELL') {
      await executeOpenOrAdd(signal, deployment, config, legType);
    } else if (signal.action === 'CLOSE') {
      for (const pos of legPositions) {
        await closePosition(deployment, pos);
      }
    }
  } else if (legType === 'protection') {
    // 保護腿：禁用馬丁加倉，只支持開倉和平倉
    if (signal.action === 'BUY' || signal.action === 'SELL') {
      // 檢查保護腿是否已有持倉
      if (legPositions.length === 0) {
        // 開倉（不支持加倉）
        await executeOpen(signal, deployment, config, legType);
      } else {
        // 已有持倉，不執行加倉
        await logModeDecision({
          deploymentId: deployment.id,
          deploymentMode: 'H3',
          legType: 'protection',
          action: signal.action,
          reason: 'H3 模式：保護腿禁用馬丁加倉',
          skipped: true,
        });
      }
    } else if (signal.action === 'CLOSE') {
      for (const pos of legPositions) {
        await closePosition(deployment, pos);
      }
    }
  }

  // 4. 檢查保護門檻（H3 模式下為 4%，其他模式為 5%）
  const protectionThreshold = strategy.key === 'KAMA_RAINBOW_MARTIN' ? 4 : 5;
  const currentDrawdown = calculateDrawdown(deployment);
  if (currentDrawdown >= protectionThreshold) {
    // 觸發保護機制，平倉所有持倉
    await closeAllPositions(deployment);
    await logModeDecision({
      deploymentId: deployment.id,
      deploymentMode: 'H3',
      action: 'CLOSE_ALL',
      reason: `H3 模式：保護門檻 ${protectionThreshold}% 已觸發`,
    });
  }

  // 5. 記錄模式決策日誌
  await logModeDecision({
    deploymentId: deployment.id,
    deploymentMode: 'H3',
    legType,
    action: signal.action,
    reason: `H3 模式：${legType === 'main' ? '主腿' : '保護腿'}`,
  });
}
```

#### 3.2.3 模式決策日誌與可觀測性

為了提高系統的可觀測性，所有模式決策都應被記錄到一個專用的日誌表中，並在 UI 中展示。

**日誌結構**：

```typescript
interface ModeDecisionLog {
  id: string;
  deploymentId: string;
  deploymentMode: 'S1' | 'M2' | 'H3';
  timestamp: Date;
  legId?: string; // M2/H3 模式下的腿 ID
  legType?: 'main' | 'protection'; // H3 模式下的腿類型
  action: string; // 'BUY', 'SELL', 'CLOSE', 'CLOSE_ALL', 'SKIP'
  reason: string; // 決策原因
  skipped: boolean; // 是否被跳過
  signalId?: string; // 關聯的信號 ID
  executionResult?: {
    success: boolean;
    orderId?: string;
    error?: string;
  };
}
```

**UI 展示**（在部署詳情或訊號日誌中）：

```
模式決策日誌

2026-08-01 10:30:45 | M2 | 腿 1 | BUY | ✓ 已執行
  原因: M2 模式：腿級隔離
  訂單 ID: order_123456

2026-08-01 10:25:30 | M2 | 腿 2 | SELL | ✓ 已執行
  原因: M2 模式：腿級隔離
  訂單 ID: order_123457

2026-08-01 10:20:15 | H3 | 保護腿 | BUY | ⊘ 已跳過
  原因: H3 模式：保護腿禁用馬丁加倉
```

#### 3.2.4 實盤執行的自動化流程

**後端主路由（`server/routers/deployments.router.ts`）**：

```typescript
// 執行信號（自動根據部署模式選擇執行邏輯）
executeSignal: protectedProcedure
  .input(z.object({
    deploymentId: z.string(),
    signal: z.object({
      action: z.enum(['BUY', 'SELL', 'CLOSE']),
      side: z.enum(['long', 'short']),
      price: z.number(),
      // ... 其他信號字段
    }),
  }))
  .mutation(async ({ ctx, input }) => {
    // 1. 查詢部署配置
    const deployment = await db.deployments.findUnique({
      where: { id: input.deploymentId },
      include: { strategy: true },
    });
    if (!deployment) throw new TRPCError({ code: 'NOT_FOUND' });

    // 2. 根據部署模式選擇執行邏輯
    let result;
    switch (deployment.deploymentMode) {
      case 'S1':
        result = await executeSignalS1(input.signal, deployment);
        break;
      case 'M2':
        result = await executeSignalM2(input.signal, deployment);
        break;
      case 'H3':
        result = await executeSignalH3(input.signal, deployment);
        break;
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown deployment mode' });
    }

    // 3. 記錄模式決策日誌
    await db.modeDecisionLogs.create({
      data: {
        deploymentId: deployment.id,
        deploymentMode: deployment.deploymentMode,
        action: input.signal.action,
        reason: result.reason,
        skipped: result.skipped,
        executionResult: result.executionResult,
      },
    });

    return result;
  }),
```

#### 3.2.5 Heartbeat 排程與定期檢查

為了確保實盤執行的穩定性，系統應通過 Heartbeat 排程定期檢查部署的狀態，並根據部署模式執行相應的風控邏輯。

**Heartbeat 任務（`server/_core/heartbeat.ts`）**：

```typescript
// 定期檢查所有活躍部署的狀態（每分鐘執行一次）
export async function checkDeploymentHealth() {
  const activeDeployments = await db.deployments.findMany({
    where: { status: 'ACTIVE' },
    include: { strategy: true },
  });

  for (const deployment of activeDeployments) {
    try {
      // 1. 檢查部署的 Preflight 狀態
      const preflightResult = await checkPreflight(deployment);
      if (!preflightResult.passed) {
        // 自動停用部署
        await db.deployments.update({
          where: { id: deployment.id },
          data: { status: 'BLOCKED' },
        });
        // 發送警報
        await notifyUser(deployment.ownerId, `部署 ${deployment.name} 已因 Preflight 失敗而停用`);
        continue;
      }

      // 2. 根據部署模式執行相應的檢查
      switch (deployment.deploymentMode) {
        case 'S1':
          await checkDeploymentHealthS1(deployment);
          break;
        case 'M2':
          await checkDeploymentHealthM2(deployment);
          break;
        case 'H3':
          await checkDeploymentHealthH3(deployment);
          break;
      }

      // 3. 更新部署的最後檢查時間
      await db.deployments.update({
        where: { id: deployment.id },
        data: { lastHealthCheckAt: new Date() },
      });
    } catch (error) {
      console.error(`Error checking deployment ${deployment.id}:`, error);
      // 記錄錯誤日誌，但不停止其他部署的檢查
    }
  }
}

// H3 模式特有的健康檢查
async function checkDeploymentHealthH3(deployment: Deployment) {
  // 1. 檢查保護門檻（4% 對於 KRM）
  const protectionThreshold = deployment.strategy.key === 'KAMA_RAINBOW_MARTIN' ? 4 : 5;
  const currentDrawdown = await calculateDrawdown(deployment);

  if (currentDrawdown >= protectionThreshold) {
    // 觸發保護機制
    await closeAllPositions(deployment);
    await notifyUser(deployment.ownerId, `部署 ${deployment.name} 已因保護門檻觸發而平倉所有持倉`);
  }

  // 2. 檢查保護腿的馬丁禁用規則
  const protectionLegPositions = await getPositionsForLeg(deployment, 'protection');
  if (protectionLegPositions.length > 1) {
    // 保護腿不應有多個持倉（禁用馬丁加倉）
    // 記錄警告日誌
    console.warn(`Deployment ${deployment.id}: Protection leg has multiple positions (Martin disabled)`);
  }
}
```

---

## 總結

通過以上三個優化方案，我們實現了：

1. **策略卡片實時切換**：用戶可直接在策略卡片上切換 S1/M2/H3 模式，無需進入複雜的 Preflight 或生命週期界面。
2. **部署工作台雙面板**：「部署管理」與「快速啟動」雙面板設計大幅提升了部署流程的效率與用戶體驗。
3. **實盤執行自動化**：實盤執行引擎能自動識別並應用部署模式的配置，確保策略行為的一致性與可預測性。

所有設計均遵循軍工級專業標準，並優先使用現有代碼與 UI 組件，以最大化開發效率與成本效益。
