/**
 * 交易對 API 路由
 * 
 * 提供以下接口：
 * - GET /api/trading-pairs - 獲取交易對列表
 * - POST /api/trading-pairs/validate - 驗證交易對
 * - POST /api/trading-pairs/normalize - 標準化交易對
 * - GET /api/trading-pairs/stats - 獲取統計信息
 */

import { Router, Request, Response } from 'express';
import { TradingPairManager } from '../services/tradingPairManager';

const router = Router();

/**
 * GET /api/trading-pairs
 * 獲取交易對列表
 * 
 * 查詢參數：
 * - instType: SWAP | SPOT | FUTURES (默認: SWAP)
 * - search: 搜索關鍵詞 (可選)
 */
router.get('/trading-pairs', async (req: Request, res: Response) => {
  try {
    const instType = (req.query.instType as string || 'SWAP') as 'SWAP' | 'SPOT' | 'FUTURES';
    const search = req.query.search as string | undefined;

    let pairs = await TradingPairManager.getAvailablePairs(instType);

    // 如果提供了搜索關鍵詞，進行篩選
    if (search) {
      const searchUpper = search.toUpperCase();
      pairs = pairs.filter((pair) => pair.includes(searchUpper));
    }

    res.json({
      success: true,
      instType,
      count: pairs.length,
      pairs,
    });
  } catch (error) {
    console.error('[TradingPairs] 獲取交易對列表失敗:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/trading-pairs/validate
 * 驗證交易對
 * 
 * 請求體：
 * {
 *   symbol: string,      // 交易對名稱
 *   instType?: string    // 交易對類型 (默認: SWAP)
 * }
 */
router.post('/trading-pairs/validate', async (req: Request, res: Response) => {
  try {
    const { symbol, instType = 'SWAP' } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const valid = await TradingPairManager.validate(symbol, instType);
    const normalized = TradingPairManager.normalize(symbol, instType);

    res.json({
      success: true,
      symbol,
      normalized,
      valid,
      instType,
    });
  } catch (error) {
    console.error('[TradingPairs] 驗證交易對失敗:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/trading-pairs/normalize
 * 標準化交易對名稱
 * 
 * 請求體：
 * {
 *   symbol: string,      // 交易對名稱
 *   instType?: string    // 交易對類型 (默認: SWAP)
 * }
 */
router.post('/trading-pairs/normalize', async (req: Request, res: Response) => {
  try {
    const { symbol, instType = 'SWAP' } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const normalized = TradingPairManager.normalize(symbol, instType);

    res.json({
      success: true,
      original: symbol,
      normalized,
      instType,
    });
  } catch (error) {
    console.error('[TradingPairs] 標準化交易對失敗:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/trading-pairs/stats
 * 獲取交易對統計信息
 */
router.get('/trading-pairs/stats', async (req: Request, res: Response) => {
  try {
    const stats = await TradingPairManager.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error('[TradingPairs] 獲取統計信息失敗:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/trading-pairs/search
 * 搜索交易對
 * 
 * 請求體：
 * {
 *   keyword: string,     // 搜索關鍵詞
 *   instType?: string    // 交易對類型 (默認: SWAP)
 * }
 */
router.post('/trading-pairs/search', async (req: Request, res: Response) => {
  try {
    const { keyword, instType = 'SWAP' } = req.body;

    if (!keyword) {
      return res.status(400).json({
        success: false,
        error: 'keyword is required',
      });
    }

    const results = await TradingPairManager.search(keyword, instType);

    res.json({
      success: true,
      keyword,
      instType,
      count: results.length,
      results: results.map((r) => ({
        instId: r.instId,
        baseCcy: r.baseCcy,
        quoteCcy: r.quoteCcy,
        instType: r.instType,
        minSz: r.minSz,
        ctVal: r.ctVal,
      })),
    });
  } catch (error) {
    console.error('[TradingPairs] 搜索交易對失敗:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/trading-pairs/config/:symbol
 * 獲取交易對配置信息
 * 
 * 路由參數：
 * - symbol: 交易對名稱
 * 
 * 查詢參數：
 * - instType: SWAP | SPOT | FUTURES (默認: SWAP)
 */
router.get('/trading-pairs/config/:symbol', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    const instType = (req.query.instType as string || 'SWAP') as 'SWAP' | 'SPOT' | 'FUTURES';

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'symbol is required',
      });
    }

    const config = await TradingPairManager.getConfig(symbol, instType);

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Trading pair not found',
      });
    }

    res.json({
      success: true,
      config,
    });
  } catch (error) {
    console.error('[TradingPairs] 獲取交易對配置失敗:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
