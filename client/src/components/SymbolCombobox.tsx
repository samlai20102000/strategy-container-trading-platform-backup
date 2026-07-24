/**
 * 交易對動態搜索下拉選單 - 依據 pasted_content_3.txt 優化 1 實作
 * 第二輪優化：
 * - 收藏（星號）功能：點擊星號收藏/取消收藏，收藏的交易對置頂顯示
 * - 交易對規格透傳：選擇時回調 minOrderQty/qtyStep，供表單自動帶入限制
 *
 * 適配說明：
 * - 原方案使用 react-select，本專案採用已內建的 shadcn Command + Popover
 *   組合為 Combobox，功能等效（搜索過濾、下拉選擇、載入狀態），
 *   避免引入新依賴並保持設計語言一致。
 * - 從所選 API 金鑰對應的交易所（Bybit/OKX）動態獲取支援的交易對清單。
 * - 選擇後回調 onChange(symbol, base, quote, minOrderQty, qtyStep)，供倉位單位動態跟隨使用。
 */
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Loader2, Star } from "lucide-react";
import { useMemo, useState } from "react";

export interface SymbolOption {
  symbol: string;
  base: string;
  quote: string;
  /** 最小下單量（base 幣量） */
  minOrderQty?: number;
  /** 數量步長 */
  qtyStep?: number;
}

/** 前端備用解析器：交易對 → base/quote（與後端 parseSymbol 邏輯一致） */
export function parseSymbolClient(symbol: string): SymbolOption {
  if (symbol.includes("-")) {
    const parts = symbol.split("-");
    return { symbol, base: parts[0] || symbol, quote: parts[1] || "USDT" };
  }
  const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "USDE", "EUR", "BTC", "ETH", "DAI", "BRL", "TRY", "USD"];
  for (const q of KNOWN_QUOTES) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { symbol, base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return { symbol, base: symbol || "BTC", quote: "USD" };
}

interface SymbolComboboxProps {
  /** 當前選中的交易對字串 */
  value: string;
  /** 交易所（由所選 API 金鑰決定），未選時默認 okx */
  exchange: "bybit" | "okx";
  /** ★ 新增：是否模擬盤環境（來自 API Key 的 isTestnet），模擬盤只顯示模擬盤支持的交易對 */
  testnet?: boolean;
  /** 選擇回調：symbol 字串 + base/quote/規格 資訊 */
  onChange: (option: SymbolOption) => void;
}

export function SymbolCombobox({ value, exchange, testnet = false, onChange }: SymbolComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { user } = useAuth();
  const utils = trpc.useUtils();

  // 當交易所變更時，獲取交易對列表（後端有 10 分鐘快取）
  // ★ 核心修復：傳入 testnet 參數，模擬盤只顯示模擬盤支持的交易對
  const symbolsQuery = trpc.exchange.getSymbols.useQuery(
    { exchange, category: "linear", testnet },
    { staleTime: 10 * 60 * 1000 },
  );

  // 收藏清單（需登入）
  const favoritesQuery = trpc.exchange.listFavorites.useQuery(
    { exchange },
    { enabled: !!user, staleTime: 60 * 1000 },
  );

  // 收藏切換（樂觀更新：先改快取，失敗回滾）
  const toggleFavorite = trpc.exchange.toggleFavorite.useMutation({
    onMutate: async ({ symbol }) => {
      await utils.exchange.listFavorites.cancel({ exchange });
      const prev = utils.exchange.listFavorites.getData({ exchange });
      utils.exchange.listFavorites.setData({ exchange }, (old) => {
        if (!old) return old;
        const exists = old.some((f) => f.symbol === symbol);
        if (exists) return old.filter((f) => f.symbol !== symbol);
        return [
          {
            id: -Date.now(),
            userId: -1,
            exchange,
            symbol,
            favKey: `optimistic:${exchange}:${symbol}`,
            createdAt: new Date(),
          },
          ...old,
        ];
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.exchange.listFavorites.setData({ exchange }, ctx.prev);
    },
    onSettled: () => {
      utils.exchange.listFavorites.invalidate({ exchange });
    },
  });

  const allSymbols = symbolsQuery.data ?? [];
  const favoriteSet = useMemo(
    () => new Set((favoritesQuery.data ?? []).map((f) => f.symbol)),
    [favoritesQuery.data],
  );

  // 搜索過濾（最多顯示 100 項避免渲染卡頓），收藏的交易對置頂
  const { favoriteItems, normalItems } = useMemo(() => {
    const kw = search.trim().toUpperCase();
    const list = kw
      ? allSymbols.filter(
          (s) => s.symbol.toUpperCase().includes(kw) || s.base.toUpperCase().includes(kw),
        )
      : allSymbols;
    const favs: typeof list = [];
    const rest: typeof list = [];
    for (const s of list) {
      if (favoriteSet.has(s.symbol)) favs.push(s);
      else rest.push(s);
    }
    return { favoriteItems: favs, normalItems: rest.slice(0, 100) };
  }, [allSymbols, search, favoriteSet]);

  const selectedDetail = useMemo(() => {
    const found = allSymbols.find((s) => s.symbol === value);
    return found ?? (value ? parseSymbolClient(value) : null);
  }, [allSymbols, value]);

  const renderItem = (s: SymbolOption, isFav: boolean) => (
    <CommandItem
      key={s.symbol}
      value={s.symbol}
      onSelect={() => {
        onChange(s);
        setOpen(false);
        setSearch("");
      }}
    >
      <Check className={cn("mr-2 h-4 w-4", value === s.symbol ? "opacity-100" : "opacity-0")} />
      <span className="flex-1 truncate">{s.symbol}</span>
      <span className="text-xs text-muted-foreground mr-1">
        {s.base}/{s.quote}
      </span>
      {user && (
        <button
          type="button"
          aria-label={isFav ? `取消收藏 ${s.symbol}` : `收藏 ${s.symbol}`}
          className="p-1 rounded hover:bg-accent"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleFavorite.mutate({ exchange, symbol: s.symbol });
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Star
            className={cn(
              "h-3.5 w-3.5",
              isFav ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/50",
            )}
          />
        </button>
      )}
    </CommandItem>
  );

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            {selectedDetail ? (
              <span className="truncate">
                {selectedDetail.symbol}
                <span className="text-muted-foreground ml-1 text-xs">
                  ({selectedDetail.base}/{selectedDetail.quote})
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">搜索交易對...</span>
            )}
            {symbolsQuery.isLoading ? (
              <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin opacity-50" />
            ) : (
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="輸入關鍵字（如 ETH）..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              {symbolsQuery.isLoading ? (
                <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  載入交易對清單...
                </div>
              ) : (
                <>
                  <CommandEmpty>找不到符合的交易對</CommandEmpty>
                  {favoriteItems.length > 0 && (
                    <CommandGroup heading="⭐ 收藏">
                      {favoriteItems.map((s) => renderItem(s, true))}
                    </CommandGroup>
                  )}
                  <CommandGroup heading={favoriteItems.length > 0 ? "全部" : undefined}>
                    {normalItems.map((s) => renderItem(s, false))}
                    {!search && allSymbols.length > 100 && (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground text-center">
                        共 {allSymbols.length} 個交易對，輸入關鍵字搜索更多
                      </div>
                    )}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground mt-1">
        💡 從交易所支援的清單中選擇，點星號收藏常用交易對
      </p>
    </div>
  );
}
