-- ============================================================
-- 數據庫遷移：統一交易對格式
-- 
-- 目的：將所有現有的交易對名稱轉換為 OKX 標準格式
-- 例：ETHUSDT → ETH-USDT-SWAP
--     ETH-USDT → ETH-USDT-SWAP
--     ETH/USDT → ETH-USDT-SWAP
-- 
-- 執行前備份數據庫！
-- ============================================================

-- 步驟 1: 為 strategies 表添加臨時列（如果不存在）
ALTER TABLE strategies ADD COLUMN symbol_normalized VARCHAR(50);

-- 步驟 2: 創建函數用於標準化交易對名稱
-- 注意：此函數實現基本的標準化邏輯
-- 完整的標準化應由應用層的 TradingPairManager 完成
CREATE FUNCTION normalize_symbol(symbol VARCHAR(50)) RETURNS VARCHAR(50) DETERMINISTIC
BEGIN
  DECLARE normalized VARCHAR(50);
  DECLARE base VARCHAR(20);
  DECLARE quote VARCHAR(20);
  
  -- 移除所有特殊字符
  SET normalized = UPPER(REPLACE(REPLACE(REPLACE(REPLACE(symbol, '-', ''), '/', ''), '_', ''), '.P', ''));
  
  -- 如果已經是標準格式（包含 SWAP），直接返回
  IF normalized LIKE '%SWAP%' THEN
    RETURN normalized;
  END IF;
  
  -- 提取基礎幣種和報價幣種
  IF normalized LIKE '%USDT%' THEN
    SET base = SUBSTRING(normalized, 1, LENGTH(normalized) - 4);
    SET quote = 'USDT';
  ELSEIF normalized LIKE '%USDC%' THEN
    SET base = SUBSTRING(normalized, 1, LENGTH(normalized) - 4);
    SET quote = 'USDC';
  ELSEIF normalized LIKE '%USD%' THEN
    SET base = SUBSTRING(normalized, 1, LENGTH(normalized) - 3);
    SET quote = 'USD';
  ELSE
    -- 無法識別，返回原始值
    RETURN symbol;
  END IF;
  
  -- 返回標準格式
  RETURN CONCAT(base, '-', quote, '-SWAP');
END;

-- 步驟 3: 使用函數更新臨時列
UPDATE strategies SET symbol_normalized = normalize_symbol(symbol);

-- 步驟 4: 驗證更新結果（檢查是否有無法標準化的交易對）
SELECT symbol, symbol_normalized FROM strategies WHERE symbol_normalized IS NULL OR symbol_normalized = symbol;

-- 步驟 5: 如果驗證通過，更新原始列
UPDATE strategies SET symbol = symbol_normalized WHERE symbol_normalized IS NOT NULL;

-- 步驟 6: 刪除臨時列
ALTER TABLE strategies DROP COLUMN symbol_normalized;

-- 步驟 7: 對其他表進行相同操作（如果存在）
-- 更新 signals 表
UPDATE signals SET symbol = normalize_symbol(symbol);

-- 更新 trades 表
UPDATE trades SET symbol = normalize_symbol(symbol);

-- 步驟 8: 刪除函數（可選，如果不再需要）
DROP FUNCTION IF EXISTS normalize_symbol;

-- ============================================================
-- 驗證遷移結果
-- ============================================================

-- 檢查 strategies 表中的交易對格式
SELECT DISTINCT symbol FROM strategies ORDER BY symbol;

-- 檢查是否有任何不符合標準格式的交易對
SELECT DISTINCT symbol FROM strategies WHERE symbol NOT LIKE '%-%-SWAP';

-- 統計各表中的交易對數量
SELECT 'strategies' as table_name, COUNT(DISTINCT symbol) as unique_symbols FROM strategies
UNION ALL
SELECT 'signals', COUNT(DISTINCT symbol) FROM signals
UNION ALL
SELECT 'trades', COUNT(DISTINCT symbol) FROM trades;

-- ============================================================
-- 完成
-- ============================================================
-- 遷移完成後，所有交易對應該都是標準格式（例：BTC-USDT-SWAP）
-- 應用層的 TradingPairManager 會進一步驗證和處理這些交易對
