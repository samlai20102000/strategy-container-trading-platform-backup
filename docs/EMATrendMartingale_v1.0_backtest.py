"""
EMATrendMartingale v1.0 — Python 回測腳本
EMA 五線共振 + 馬丁格爾加倉策略
專為 XAUUSD M30 設計

使用方式：
  pip install pandas numpy
  python EMATrendMartingale_v1.0_backtest.py

數據格式要求：CSV 文件包含 timestamp, open, high, low, close, volume 欄位
"""

import pandas as pd
import numpy as np
from dataclasses import dataclass, field
from typing import List, Optional
import json
import sys

# ============================================================
# 策略參數
# ============================================================
@dataclass
class StrategyParams:
    """EMA 馬丁策略參數"""
    # 指標參數
    timeframe_enter: int = 30          # 入場時間框架（分鐘）
    ema1_period: int = 3               # EMA1 週期（最快線）
    ema2_period: int = 6               # EMA2 週期
    ema3_period: int = 15              # EMA3 週期
    ema4_period: int = 30              # EMA4 週期
    ema5_period: int = 60              # EMA5 週期（最慢線）
    
    # 資金與加倉參數
    initial_capital: float = 10000.0   # 初始資金
    first_lot: float = 0.01            # 首單手數
    martin_multiplier: float = 1.5     # 馬丁倍率
    add_order_step: int = 300          # 加倉間距（點數）
    max_martin_levels: int = 10        # 最大加倉層數
    
    # 出場與過濾參數
    target_profit_percent: float = 1.0 # 整體止盈（%）
    min_ema_distance_pips: int = 100   # EMA 最小間距（點數）
    max_spread: int = 50               # 最大點差（點數）
    
    # 風控參數
    enable_trend_breach_exit: bool = True   # 趨勢破壞強制平倉
    max_drawdown_percent: float = 5.0      # 最大回撤保護（%）
    enable_drawdown_protect: bool = False   # 啟用回撤保護
    
    # 訂單管理
    magic_number: int = 20415
    point: float = 0.01               # 黃金 2 位小數點

# ============================================================
# 訂單和持倉結構
# ============================================================
@dataclass
class Order:
    """訂單結構"""
    ticket: int
    direction: int          # 1=多, -1=空
    lot: float
    entry_price: float
    entry_time: pd.Timestamp
    level: int              # 馬丁層數（0=首單）

@dataclass
class TradeResult:
    """交易結果"""
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    direction: int
    total_lots: float
    avg_entry: float
    exit_price: float
    pnl: float
    max_level: int
    exit_reason: str

# ============================================================
# 回測引擎
# ============================================================
class EMATrendMartingaleBacktest:
    def __init__(self, params: StrategyParams):
        self.params = params
        self.orders: List[Order] = []
        self.trades: List[TradeResult] = []
        self.equity_curve: List[float] = []
        self.peak_equity: float = params.initial_capital
        self.current_level: int = 0
        self.trade_direction: int = 0
        self.last_entry_price: float = 0
        self.ticket_counter: int = 0
        self.balance: float = params.initial_capital
        
    def calculate_emas(self, df: pd.DataFrame) -> pd.DataFrame:
        """計算五條 EMA"""
        periods = [
            self.params.ema1_period,
            self.params.ema2_period,
            self.params.ema3_period,
            self.params.ema4_period,
            self.params.ema5_period,
        ]
        for i, p in enumerate(periods, 1):
            df[f'ema{i}'] = df['close'].ewm(span=p, adjust=False).mean()
        return df
    
    def check_ema_alignment(self, row: pd.Series) -> int:
        """
        檢查五線共振
        返回: 1=多頭, -1=空頭, 0=無信號
        """
        emas = [row['ema1'], row['ema2'], row['ema3'], row['ema4'], row['ema5']]
        min_dist = self.params.min_ema_distance_pips * self.params.point
        
        # 多頭排列
        if all(emas[i] > emas[i+1] for i in range(4)):
            if all(emas[i] - emas[i+1] >= min_dist for i in range(4)):
                return 1
        
        # 空頭排列
        if all(emas[i] < emas[i+1] for i in range(4)):
            if all(emas[i+1] - emas[i] >= min_dist for i in range(4)):
                return -1
        
        return 0
    
    def is_trend_broken(self, row: pd.Series) -> bool:
        """檢查趨勢是否被破壞"""
        if not self.params.enable_trend_breach_exit:
            return False
        if self.trade_direction == 0:
            return False
            
        emas = [row['ema1'], row['ema2'], row['ema3'], row['ema4'], row['ema5']]
        
        if self.trade_direction == 1:  # 多頭
            return any(emas[i] < emas[i+1] for i in range(4))
        else:  # 空頭
            return any(emas[i] > emas[i+1] for i in range(4))
    
    def calculate_lot(self, level: int) -> float:
        """計算馬丁手數"""
        return round(self.params.first_lot * (self.params.martin_multiplier ** level), 2)
    
    def get_total_pnl(self, current_price: float) -> float:
        """計算所有持倉的浮動盈虧"""
        total = 0.0
        for order in self.orders:
            if order.direction == 1:
                total += (current_price - order.entry_price) * order.lot * 100  # 黃金 1 手 = 100 盎司
            else:
                total += (order.entry_price - current_price) * order.lot * 100
        return total
    
    def close_all(self, price: float, time: pd.Timestamp, reason: str):
        """全部平倉"""
        if not self.orders:
            return
            
        total_pnl = self.get_total_pnl(price)
        total_lots = sum(o.lot for o in self.orders)
        avg_entry = sum(o.entry_price * o.lot for o in self.orders) / total_lots if total_lots > 0 else 0
        
        trade = TradeResult(
            entry_time=self.orders[0].entry_time,
            exit_time=time,
            direction=self.trade_direction,
            total_lots=total_lots,
            avg_entry=avg_entry,
            exit_price=price,
            pnl=total_pnl,
            max_level=self.current_level,
            exit_reason=reason,
        )
        self.trades.append(trade)
        self.balance += total_pnl
        
        # 重置狀態
        self.orders = []
        self.current_level = 0
        self.trade_direction = 0
        self.last_entry_price = 0
    
    def run(self, df: pd.DataFrame) -> dict:
        """
        執行回測
        df: 包含 timestamp, open, high, low, close, volume 的 DataFrame
        """
        # 計算 EMA
        df = self.calculate_emas(df)
        
        # 確保有足夠的預熱期
        warmup = max(self.params.ema5_period * 2, 120)
        
        for i in range(warmup, len(df)):
            row = df.iloc[i]
            price = row['close']
            time = row['timestamp'] if 'timestamp' in row.index else df.index[i]
            
            # 更新峰值淨值
            current_equity = self.balance + self.get_total_pnl(price)
            if current_equity > self.peak_equity:
                self.peak_equity = current_equity
            self.equity_curve.append(current_equity)
            
            # --- 回撤保護 ---
            if self.params.enable_drawdown_protect and self.peak_equity > 0:
                dd_pct = (self.peak_equity - current_equity) / self.peak_equity * 100
                if dd_pct >= self.params.max_drawdown_percent:
                    self.close_all(price, time, "最大回撤保護觸發")
                    continue
            
            # --- 趨勢破壞平倉 ---
            if self.orders and self.is_trend_broken(row):
                self.close_all(price, time, "趨勢破壞強制平倉")
                continue
            
            # --- 整體止盈 ---
            if self.orders:
                total_pnl = self.get_total_pnl(price)
                target = current_equity * self.params.target_profit_percent / 100
                if total_pnl >= target:
                    self.close_all(price, time, "整體止盈達標")
                    continue
            
            # --- 馬丁加倉 ---
            if self.orders and self.current_level < self.params.max_martin_levels:
                step_dist = self.params.add_order_step * self.params.point
                
                if self.trade_direction == 1 and self.last_entry_price - price >= step_dist:
                    lot = self.calculate_lot(self.current_level + 1)
                    self.ticket_counter += 1
                    self.orders.append(Order(
                        ticket=self.ticket_counter,
                        direction=1,
                        lot=lot,
                        entry_price=price,
                        entry_time=time,
                        level=self.current_level + 1,
                    ))
                    self.current_level += 1
                    self.last_entry_price = price
                    
                elif self.trade_direction == -1 and price - self.last_entry_price >= step_dist:
                    lot = self.calculate_lot(self.current_level + 1)
                    self.ticket_counter += 1
                    self.orders.append(Order(
                        ticket=self.ticket_counter,
                        direction=-1,
                        lot=lot,
                        entry_price=price,
                        entry_time=time,
                        level=self.current_level + 1,
                    ))
                    self.current_level += 1
                    self.last_entry_price = price
            
            # --- 新入場 ---
            if not self.orders:
                signal = self.check_ema_alignment(row)
                if signal != 0:
                    lot = self.params.first_lot
                    self.ticket_counter += 1
                    self.orders.append(Order(
                        ticket=self.ticket_counter,
                        direction=signal,
                        lot=lot,
                        entry_price=price,
                        entry_time=time,
                        level=0,
                    ))
                    self.trade_direction = signal
                    self.current_level = 0
                    self.last_entry_price = price
        
        # 回測結束，平掉剩餘持倉
        if self.orders:
            last_price = df.iloc[-1]['close']
            last_time = df.iloc[-1]['timestamp'] if 'timestamp' in df.columns else df.index[-1]
            self.close_all(last_price, last_time, "回測結束平倉")
        
        return self.generate_report()
    
    def generate_report(self) -> dict:
        """生成回測報告"""
        if not self.trades:
            return {"error": "無交易記錄"}
        
        wins = [t for t in self.trades if t.pnl > 0]
        losses = [t for t in self.trades if t.pnl <= 0]
        
        total_pnl = sum(t.pnl for t in self.trades)
        win_rate = len(wins) / len(self.trades) * 100 if self.trades else 0
        
        avg_win = np.mean([t.pnl for t in wins]) if wins else 0
        avg_loss = np.mean([t.pnl for t in losses]) if losses else 0
        profit_factor = abs(sum(t.pnl for t in wins) / sum(t.pnl for t in losses)) if losses and sum(t.pnl for t in losses) != 0 else float('inf')
        
        # 最大回撤
        equity_arr = np.array(self.equity_curve) if self.equity_curve else np.array([self.params.initial_capital])
        peak = np.maximum.accumulate(equity_arr)
        drawdown = (peak - equity_arr) / peak * 100
        max_dd = np.max(drawdown) if len(drawdown) > 0 else 0
        
        # 最大連續虧損
        max_consecutive_loss = 0
        current_streak = 0
        for t in self.trades:
            if t.pnl <= 0:
                current_streak += 1
                max_consecutive_loss = max(max_consecutive_loss, current_streak)
            else:
                current_streak = 0
        
        return {
            "summary": {
                "initial_capital": self.params.initial_capital,
                "final_balance": self.balance,
                "total_pnl": round(total_pnl, 2),
                "return_pct": round((self.balance - self.params.initial_capital) / self.params.initial_capital * 100, 2),
                "total_trades": len(self.trades),
                "win_trades": len(wins),
                "loss_trades": len(losses),
                "win_rate": round(win_rate, 2),
                "avg_win": round(avg_win, 2),
                "avg_loss": round(avg_loss, 2),
                "profit_factor": round(profit_factor, 2),
                "max_drawdown_pct": round(max_dd, 2),
                "max_consecutive_loss": max_consecutive_loss,
            },
            "trades": [
                {
                    "entry_time": str(t.entry_time),
                    "exit_time": str(t.exit_time),
                    "direction": "BUY" if t.direction == 1 else "SELL",
                    "total_lots": t.total_lots,
                    "avg_entry": round(t.avg_entry, 2),
                    "exit_price": round(t.exit_price, 2),
                    "pnl": round(t.pnl, 2),
                    "max_level": t.max_level,
                    "exit_reason": t.exit_reason,
                }
                for t in self.trades
            ],
            "equity_curve": self.equity_curve[-500:] if len(self.equity_curve) > 500 else self.equity_curve,
        }


# ============================================================
# 主程序
# ============================================================
def main():
    """主程序入口"""
    # 默認參數
    params = StrategyParams()
    
    # 讀取數據
    data_file = sys.argv[1] if len(sys.argv) > 1 else "XAUUSD_M30.csv"
    
    try:
        df = pd.read_csv(data_file)
        if 'timestamp' not in df.columns and 'time' in df.columns:
            df.rename(columns={'time': 'timestamp'}, inplace=True)
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        df.sort_values('timestamp', inplace=True)
        df.reset_index(drop=True, inplace=True)
    except FileNotFoundError:
        print(f"錯誤：找不到數據文件 {data_file}")
        print("請提供包含 timestamp, open, high, low, close, volume 欄位的 CSV 文件")
        sys.exit(1)
    
    print(f"載入數據: {len(df)} 根 K 線")
    print(f"時間範圍: {df['timestamp'].iloc[0]} ~ {df['timestamp'].iloc[-1]}")
    print(f"策略參數: EMA({params.ema1_period}/{params.ema2_period}/{params.ema3_period}/{params.ema4_period}/{params.ema5_period})")
    print(f"馬丁: 首單={params.first_lot} 倍率={params.martin_multiplier} 間距={params.add_order_step}pts 最大層={params.max_martin_levels}")
    print("-" * 60)
    
    # 執行回測
    engine = EMATrendMartingaleBacktest(params)
    result = engine.run(df)
    
    # 輸出結果
    if "error" in result:
        print(f"回測失敗: {result['error']}")
        return
    
    summary = result["summary"]
    print("\n" + "=" * 60)
    print("EMATrendMartingale v1.0 回測報告")
    print("=" * 60)
    print(f"初始資金:     {summary['initial_capital']:,.2f} USDT")
    print(f"最終餘額:     {summary['final_balance']:,.2f} USDT")
    print(f"總盈虧:       {summary['total_pnl']:+,.2f} USDT ({summary['return_pct']:+.2f}%)")
    print(f"總交易次數:   {summary['total_trades']}")
    print(f"勝率:         {summary['win_rate']:.1f}%")
    print(f"盈虧比:       {summary['profit_factor']:.2f}")
    print(f"平均盈利:     {summary['avg_win']:+,.2f}")
    print(f"平均虧損:     {summary['avg_loss']:+,.2f}")
    print(f"最大回撤:     {summary['max_drawdown_pct']:.2f}%")
    print(f"最大連虧:     {summary['max_consecutive_loss']} 次")
    print("=" * 60)
    
    # 保存結果到 JSON
    output_file = "backtest_result.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2, default=str)
    print(f"\n詳細結果已保存到: {output_file}")


if __name__ == "__main__":
    main()
