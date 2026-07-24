/**
 * StrategySelector - 統一策略選擇器（V4.2）
 * 所有模塊共用：回測中心、策略管理、參數快照庫
 * 從 registry.listDefinitions 獲取策略列表，確保所有模塊看到相同數據
 */
import { trpc } from "@/lib/trpc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface StrategySelectorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  showBadge?: boolean;
  className?: string;
  includeAll?: boolean;
}

export function StrategySelector({
  value,
  onChange,
  placeholder = "請選擇策略...",
  disabled = false,
  showBadge = true,
  className = "",
  includeAll = false,
}: StrategySelectorProps) {
  const { data: strategies, isLoading } = trpc.registry.listDefinitions.useQuery(undefined);

  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled || isLoading}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={isLoading ? "載入中..." : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && (
          <SelectItem value="all">全部策略</SelectItem>
        )}
        {strategies?.map((s) => (
          <SelectItem key={s.key} value={s.key}>
            <span className="flex items-center gap-2">
              <span className="truncate">{s.name}</span>
              {showBadge && s.isBuiltIn && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0">內建</Badge>
              )}
              {showBadge && !s.isBuiltIn && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">自訂</Badge>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
