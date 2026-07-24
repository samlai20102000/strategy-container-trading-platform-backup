/**
 * 交易對選擇器組件
 * 
 * 功能：
 * 1. 顯示 OKX 上所有可用的交易對
 * 2. 支持搜索和篩選
 * 3. 支持多種交易對類型（SWAP、SPOT、FUTURES）
 * 4. 實時驗證選擇的交易對
 * 5. 顯示交易對詳細信息
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export interface TradingPairSelectorProps {
  value?: string;
  onChange?: (symbol: string) => void;
  instType?: 'SWAP' | 'SPOT' | 'FUTURES';
  onInstTypeChange?: (type: 'SWAP' | 'SPOT' | 'FUTURES') => void;
  disabled?: boolean;
  showDetails?: boolean;
}

export const TradingPairSelector: React.FC<TradingPairSelectorProps> = ({
  value = '',
  onChange,
  instType = 'SWAP',
  onInstTypeChange,
  disabled = false,
  showDetails = true,
}) => {
  const [pairs, setPairs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [isValid, setIsValid] = useState<boolean | null>(null);

  // 獲取交易對列表
  useEffect(() => {
    const fetchPairs = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/trading-pairs?instType=${instType}`);
        if (!response.ok) {
          throw new Error('Failed to fetch trading pairs');
        }

        const data = await response.json();
        setPairs(data.pairs || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setPairs([]);
      } finally {
        setLoading(false);
      }
    };

    fetchPairs();
  }, [instType]);

  // 驗證選擇的交易對
  useEffect(() => {
    if (!value) {
      setIsValid(null);
      return;
    }

    const validatePair = async () => {
      setIsValidating(true);

      try {
        const response = await fetch(`/api/trading-pairs/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: value, instType }),
        });

        const data = await response.json();
        setIsValid(data.valid);
      } catch (err) {
        setIsValid(false);
      } finally {
        setIsValidating(false);
      }
    };

    validatePair();
  }, [value, instType]);

  // 篩選交易對
  const filteredPairs = useMemo(() => {
    if (!searchText) return pairs;

    const search = searchText.toUpperCase();
    return pairs.filter(
      (pair) =>
        pair.includes(search) ||
        pair.replace(/-SWAP$|-SPOT$|-FUTURES$/, '').includes(search)
    );
  }, [pairs, searchText]);

  return (
    <div className="space-y-4">
      {/* 交易對類型選擇 */}
      <div className="flex gap-2">
        <label className="text-sm font-medium">交易對類型</label>
        <Select value={instType} onValueChange={(v) => onInstTypeChange?.(v as any)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="SWAP">永續合約</SelectItem>
            <SelectItem value="SPOT">現貨</SelectItem>
            <SelectItem value="FUTURES">期貨</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 搜索框 */}
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="搜索交易對 (e.g., ETH, BTC, USDT)"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="pl-10"
          disabled={disabled || loading}
        />
      </div>

      {/* 交易對選擇 */}
      <Select value={value} onValueChange={onChange} disabled={disabled || loading}>
        <SelectTrigger>
          <SelectValue placeholder={loading ? '加載中...' : '選擇交易對'} />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {loading ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-red-500">{error}</div>
          ) : filteredPairs.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">未找到交易對</div>
          ) : (
            filteredPairs.map((pair) => (
              <SelectItem key={pair} value={pair}>
                {pair}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>

      {/* 驗證狀態 */}
      {showDetails && value && (
        <div className="flex items-center gap-2">
          {isValidating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm text-muted-foreground">驗證中...</span>
            </>
          ) : isValid ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <span className="text-sm text-green-600">交易對有效</span>
            </>
          ) : isValid === false ? (
            <>
              <AlertCircle className="h-4 w-4 text-red-500" />
              <span className="text-sm text-red-600">交易對無效或不可交易</span>
            </>
          ) : null}
        </div>
      )}

      {/* 統計信息 */}
      {showDetails && !loading && (
        <div className="text-xs text-muted-foreground">
          {filteredPairs.length > 0 ? (
            <>
              顯示 {filteredPairs.length} / {pairs.length} 個交易對
            </>
          ) : (
            <>
              共 {pairs.length} 個交易對可用
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default TradingPairSelector;
