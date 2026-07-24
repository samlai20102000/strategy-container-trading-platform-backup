// client/src/components/BacktestPanel.tsx
// 🔥 V4.0：固定金本位馬丁參數面板

import { useState } from 'react';

export const BacktestPanel = () => {
  const [config, setConfig] = useState({
    // 固定金本位核心參數
    Initial_Capital: 10000,
    Base_Lot_Size: 30,
    Max_Loss_Pct: 5.0,

    // KAMA 參數
    KAMA_Fast_Length: 50,
    p2_fastest: 10,
    p3_slowest: 2,
    KAMA_Slow_Length: 50,
    q2_fastest: 10,
    q3_slowest: 6,

    // 馬丁參數
    Martin_Step_Pct: 2.0,
    Max_Layers: 11,
    Target_TP_Pct: 1.0,
    Callback_Pct: 0.1,
    K_Line_Period: 30,
    Kama_Reversal_Min_Layer: 3,
  });

  const [martinLayers, setMartinLayers] = useState([
    { start: 1, end: 4, multiplier: 1.5 },
    { start: 5, end: 9, multiplier: 1.1 },
    { start: 10, end: 11, multiplier: 1.0 },
  ]);

  // 計算當前參數對應的數值
  const maxLossAmount = config.Initial_Capital * (config.Max_Loss_Pct / 100);

  return (
    <div className="bg-white rounded-lg shadow p-6">
      {/* ========================================================== */}
      {/* 🔥 固定金本位參數區塊 */}
      {/* ========================================================== */}
      <div className="border-l-4 border-purple-500 pl-4 mb-6">
        <h3 className="text-sm font-semibold text-purple-600 mb-3 flex items-center">
          💰 固定金本位馬丁參數
          <span className="text-xs text-gray-400 ml-2">（USDT 金額模式）</span>
        </h3>

        <div className="grid grid-cols-3 gap-4">
          {/* 初始本金 */}
          <div>
            <label className="block text-xs text-gray-500">初始本金 (Initial_Capital)</label>
            <input
              type="number"
              className="w-full border rounded px-2 py-1 text-sm"
              value={config.Initial_Capital}
              onChange={(e) =>
                setConfig({ ...config, Initial_Capital: parseFloat(e.target.value) || 10000 })
              }
              min={100}
              step={1000}
            />
            <p className="text-xs text-gray-400 mt-0.5">💡 策略專屬本金（USDT）</p>
          </div>

          {/* 首單金額 */}
          <div>
            <label className="block text-xs text-gray-500">首單金額 (Base_Lot_Size)</label>
            <div className="flex items-center">
              <input
                type="number"
                step="1"
                className="flex-1 border rounded-l px-2 py-1 text-sm"
                value={config.Base_Lot_Size}
                onChange={(e) =>
                  setConfig({ ...config, Base_Lot_Size: parseFloat(e.target.value) || 30 })
                }
                min={1}
                max={10000}
              />
              <span className="bg-gray-100 border border-l-0 rounded-r px-2 py-1 text-xs text-gray-500">
                USDT
              </span>
            </div>
            <p className="text-xs text-green-600 mt-0.5">
              = {config.Base_Lot_Size} USDT 固定首單
            </p>
          </div>

          {/* 硬止損 */}
          <div>
            <label className="block text-xs text-gray-500">硬止損 (Max_Loss_Pct)</label>
            <div className="flex items-center">
              <input
                type="number"
                step="0.5"
                className="flex-1 border rounded-l px-2 py-1 text-sm"
                value={config.Max_Loss_Pct}
                onChange={(e) =>
                  setConfig({ ...config, Max_Loss_Pct: parseFloat(e.target.value) || 5.0 })
                }
                min={1}
                max={50}
              />
              <span className="bg-gray-100 border border-l-0 rounded-r px-2 py-1 text-xs text-gray-500">
                %
              </span>
            </div>
            <p className="text-xs text-red-500 mt-0.5">
              觸發點 = {maxLossAmount.toFixed(0)} USDT（{config.Initial_Capital} × {config.Max_Loss_Pct}%）
            </p>
          </div>
        </div>
      </div>

      {/* 其他參數區塊... */}
      <div className="text-xs text-gray-400 mt-4">
        馬丁分層：{JSON.stringify(martinLayers)}
      </div>
    </div>
  );
};

export default BacktestPanel;
