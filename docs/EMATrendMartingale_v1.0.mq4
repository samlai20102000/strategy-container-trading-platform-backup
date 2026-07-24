//+------------------------------------------------------------------+
//|                                    EMATrendMartingale_v1.0.mq4   |
//|                        EMA 五線共振 + 馬丁格爾加倉策略            |
//|                        專為 XAUUSD M30 設計                       |
//+------------------------------------------------------------------+
#property copyright "EMATrendMartingale v1.0"
#property link      ""
#property version   "1.00"
#property strict

//--- 指標參數
extern int    TimeFrameEnter       = 30;       // 入場時間框架（分鐘）
extern int    EMA1_Period          = 3;        // EMA1 週期（最快線）
extern int    EMA2_Period          = 6;        // EMA2 週期
extern int    EMA3_Period          = 15;       // EMA3 週期
extern int    EMA4_Period          = 30;       // EMA4 週期
extern int    EMA5_Period          = 60;       // EMA5 週期（最慢線）

//--- 資金與加倉參數
extern double FirstLot             = 0.01;     // 首單手數
extern double MartinMultiplier     = 1.5;      // 馬丁倍率
extern int    AddOrderStep         = 300;      // 加倉間距（點數）
extern int    MaxMartinLevels      = 10;       // 最大加倉層數

//--- 出場與過濾參數
extern double TargetProfitPercent  = 1.0;      // 整體止盈（%）
extern int    MinEMADistancePips   = 100;      // EMA 最小間距（點數）
extern int    MaxSpread            = 50;       // 最大點差（點數）

//--- 風控參數
extern bool   EnableTrendBreachExit = true;    // 趨勢破壞強制平倉
extern double MaxDrawdownPercent   = 5.0;      // 最大回撤保護（%）
extern bool   EnableDrawdownProtect = false;   // 啟用回撤保護

//--- 訂單管理
extern int    MagicNumber          = 20415;    // Magic Number
extern string OrderComment         = "EMA_Martin"; // 訂單備註
extern int    Slippage             = 30;       // 滑點容許（點數）

//--- 全局變量
int    currentLevel = 0;           // 當前馬丁層數
double lastEntryPrice = 0;         // 最後入場價
double peakEquity = 0;             // 峰值淨值
int    tradeDirection = 0;         // 交易方向：1=多, -1=空, 0=無

//+------------------------------------------------------------------+
//| Expert initialization function                                     |
//+------------------------------------------------------------------+
int OnInit()
{
   peakEquity = AccountEquity();
   Print("EMATrendMartingale v1.0 初始化完成");
   Print("品種: ", Symbol(), " 時間框架: M", TimeFrameEnter);
   Print("EMA 週期: ", EMA1_Period, "/", EMA2_Period, "/", EMA3_Period, "/", EMA4_Period, "/", EMA5_Period);
   Print("首單: ", FirstLot, " 倍率: ", MartinMultiplier, " 間距: ", AddOrderStep, " 最大層: ", MaxMartinLevels);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                    |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("EMATrendMartingale v1.0 已停止，原因: ", reason);
}

//+------------------------------------------------------------------+
//| 計算 EMA 值                                                        |
//+------------------------------------------------------------------+
double GetEMA(int period, int shift=0)
{
   return iMA(Symbol(), TimeFrameEnter, period, 0, MODE_EMA, PRICE_CLOSE, shift);
}

//+------------------------------------------------------------------+
//| 檢查五線共振（完全發散）                                           |
//+------------------------------------------------------------------+
int CheckEMAAlignment()
{
   double ema1 = GetEMA(EMA1_Period);
   double ema2 = GetEMA(EMA2_Period);
   double ema3 = GetEMA(EMA3_Period);
   double ema4 = GetEMA(EMA4_Period);
   double ema5 = GetEMA(EMA5_Period);
   
   double minDist = MinEMADistancePips * Point;
   
   // 多頭排列：EMA1 > EMA2 > EMA3 > EMA4 > EMA5
   if(ema1 > ema2 && ema2 > ema3 && ema3 > ema4 && ema4 > ema5)
   {
      // 檢查相鄰間距
      if((ema1-ema2) >= minDist && (ema2-ema3) >= minDist && 
         (ema3-ema4) >= minDist && (ema4-ema5) >= minDist)
         return 1; // 多頭
   }
   
   // 空頭排列：EMA5 > EMA4 > EMA3 > EMA2 > EMA1
   if(ema5 > ema4 && ema4 > ema3 && ema3 > ema2 && ema2 > ema1)
   {
      // 檢查相鄰間距
      if((ema5-ema4) >= minDist && (ema4-ema3) >= minDist && 
         (ema3-ema2) >= minDist && (ema2-ema1) >= minDist)
         return -1; // 空頭
   }
   
   return 0; // 無信號
}

//+------------------------------------------------------------------+
//| 檢查趨勢是否被破壞                                                 |
//+------------------------------------------------------------------+
bool IsTrendBroken()
{
   if(!EnableTrendBreachExit) return false;
   if(tradeDirection == 0) return false;
   
   double ema1 = GetEMA(EMA1_Period);
   double ema2 = GetEMA(EMA2_Period);
   double ema3 = GetEMA(EMA3_Period);
   double ema4 = GetEMA(EMA4_Period);
   double ema5 = GetEMA(EMA5_Period);
   
   if(tradeDirection == 1) // 多頭持倉
   {
      // 任何相鄰 EMA 交叉即視為趨勢破壞
      if(ema1 < ema2 || ema2 < ema3 || ema3 < ema4 || ema4 < ema5)
         return true;
   }
   else if(tradeDirection == -1) // 空頭持倉
   {
      if(ema5 < ema4 || ema4 < ema3 || ema3 < ema2 || ema2 < ema1)
         return true;
   }
   
   return false;
}

//+------------------------------------------------------------------+
//| 計算當前所有訂單的總利潤                                           |
//+------------------------------------------------------------------+
double GetTotalProfit()
{
   double total = 0;
   for(int i = OrdersTotal()-1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderMagicNumber() == MagicNumber && OrderSymbol() == Symbol())
         {
            total += OrderProfit() + OrderSwap() + OrderCommission();
         }
      }
   }
   return total;
}

//+------------------------------------------------------------------+
//| 計算當前持倉訂單數量                                               |
//+------------------------------------------------------------------+
int CountOrders()
{
   int count = 0;
   for(int i = OrdersTotal()-1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderMagicNumber() == MagicNumber && OrderSymbol() == Symbol())
            count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| 計算馬丁手數                                                       |
//+------------------------------------------------------------------+
double CalculateLot(int level)
{
   double lot = FirstLot * MathPow(MartinMultiplier, level);
   lot = NormalizeDouble(lot, 2);
   double minLot = MarketInfo(Symbol(), MODE_MINLOT);
   double maxLot = MarketInfo(Symbol(), MODE_MAXLOT);
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;
   return lot;
}

//+------------------------------------------------------------------+
//| 全部平倉                                                           |
//+------------------------------------------------------------------+
void CloseAllOrders(string reason)
{
   for(int i = OrdersTotal()-1; i >= 0; i--)
   {
      if(OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
      {
         if(OrderMagicNumber() == MagicNumber && OrderSymbol() == Symbol())
         {
            double closePrice;
            if(OrderType() == OP_BUY)
               closePrice = MarketInfo(Symbol(), MODE_BID);
            else
               closePrice = MarketInfo(Symbol(), MODE_ASK);
            
            bool result = OrderClose(OrderTicket(), OrderLots(), closePrice, Slippage, clrRed);
            if(!result)
               Print("平倉失敗: ", GetLastError(), " 原因: ", reason);
            else
               Print("平倉成功: Ticket=", OrderTicket(), " 原因: ", reason);
         }
      }
   }
   currentLevel = 0;
   lastEntryPrice = 0;
   tradeDirection = 0;
}

//+------------------------------------------------------------------+
//| Expert tick function                                                |
//+------------------------------------------------------------------+
void OnTick()
{
   // 更新峰值淨值
   if(AccountEquity() > peakEquity)
      peakEquity = AccountEquity();
   
   //--- 1. 點差過濾
   double currentSpread = MarketInfo(Symbol(), MODE_SPREAD);
   if(currentSpread > MaxSpread)
      return;
   
   //--- 2. 回撤保護
   if(EnableDrawdownProtect && peakEquity > 0)
   {
      double drawdownPct = (peakEquity - AccountEquity()) / peakEquity * 100;
      if(drawdownPct >= MaxDrawdownPercent)
      {
         CloseAllOrders("最大回撤保護觸發");
         return;
      }
   }
   
   //--- 3. 趨勢破壞平倉
   if(CountOrders() > 0 && IsTrendBroken())
   {
      CloseAllOrders("趨勢破壞強制平倉");
      return;
   }
   
   //--- 4. Basket Close（整體止盈）
   if(CountOrders() > 0)
   {
      double totalProfit = GetTotalProfit();
      double targetProfit = AccountEquity() * TargetProfitPercent / 100.0;
      if(totalProfit >= targetProfit)
      {
         CloseAllOrders("整體止盈達標");
         return;
      }
   }
   
   //--- 5. 馬丁加倉邏輯
   if(CountOrders() > 0 && currentLevel < MaxMartinLevels)
   {
      double currentPrice = (tradeDirection == 1) ? MarketInfo(Symbol(), MODE_BID) : MarketInfo(Symbol(), MODE_ASK);
      double stepDistance = AddOrderStep * Point;
      
      if(tradeDirection == 1 && lastEntryPrice - currentPrice >= stepDistance)
      {
         // 多頭加倉
         double lot = CalculateLot(currentLevel);
         int ticket = OrderSend(Symbol(), OP_BUY, lot, Ask, Slippage, 0, 0, OrderComment, MagicNumber, 0, clrGreen);
         if(ticket > 0)
         {
            currentLevel++;
            lastEntryPrice = Ask;
            Print("馬丁加倉 BUY 第", currentLevel, "層, 手數=", lot);
         }
      }
      else if(tradeDirection == -1 && currentPrice - lastEntryPrice >= stepDistance)
      {
         // 空頭加倉
         double lot = CalculateLot(currentLevel);
         int ticket = OrderSend(Symbol(), OP_SELL, lot, Bid, Slippage, 0, 0, OrderComment, MagicNumber, 0, clrRed);
         if(ticket > 0)
         {
            currentLevel++;
            lastEntryPrice = Bid;
            Print("馬丁加倉 SELL 第", currentLevel, "層, 手數=", lot);
         }
      }
   }
   
   //--- 6. 新入場信號（無持倉時）
   if(CountOrders() == 0)
   {
      int signal = CheckEMAAlignment();
      
      if(signal == 1) // 多頭信號
      {
         double lot = FirstLot;
         int ticket = OrderSend(Symbol(), OP_BUY, lot, Ask, Slippage, 0, 0, OrderComment, MagicNumber, 0, clrGreen);
         if(ticket > 0)
         {
            tradeDirection = 1;
            currentLevel = 0;
            lastEntryPrice = Ask;
            Print("首單入場 BUY, 手數=", lot, " EMA 五線多頭共振");
         }
         else
            Print("開單失敗: ", GetLastError());
      }
      else if(signal == -1) // 空頭信號
      {
         double lot = FirstLot;
         int ticket = OrderSend(Symbol(), OP_SELL, lot, Bid, Slippage, 0, 0, OrderComment, MagicNumber, 0, clrRed);
         if(ticket > 0)
         {
            tradeDirection = -1;
            currentLevel = 0;
            lastEntryPrice = Bid;
            Print("首單入場 SELL, 手數=", lot, " EMA 五線空頭共振");
         }
         else
            Print("開單失敗: ", GetLastError());
      }
   }
}
//+------------------------------------------------------------------+
