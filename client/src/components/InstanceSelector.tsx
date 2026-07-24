/**
 * InstanceSelector - 策略實例選擇器（V4.2）
 * 用於參數快照庫等需要選擇實例的模塊
 * 從 registry.listInstances 獲取實例列表，含關聯的策略名稱
 */
import { trpc } from "@/lib/trpc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface InstanceSelectorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  filterByStrategy?: string; // 只顯示特定策略的實例
  className?: string;
}

export function InstanceSelector({
  value,
  onChange,
  placeholder = "請選擇策略實例...",
  disabled = false,
  filterByStrategy,
  className = "",
}: InstanceSelectorProps) {
  const { data: instances, isLoading } = trpc.registry.listInstances.useQuery();

  let filteredInstances = instances ?? [];
  if (filterByStrategy && filterByStrategy !== "all") {
    filteredInstances = filteredInstances.filter(
      (i) => i.strategyKey === filterByStrategy
    );
  }

  const getStatusIcon = (enabled: boolean) => {
    return enabled ? "🟢" : "⏹️";
  };

  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled || isLoading}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={isLoading ? "載入中..." : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {filteredInstances.length === 0 ? (
          <SelectItem value="__none" disabled>
            暫無策略實例
          </SelectItem>
        ) : (
          filteredInstances.map((inst) => (
            <SelectItem key={inst.id} value={String(inst.id)}>
              <span className="flex items-center gap-2">
                <span>{getStatusIcon(inst.enabled)}</span>
                <span className="truncate">{inst.name}</span>
                <span className="text-muted-foreground text-xs">
                  {inst.exchange} {inst.symbol}
                </span>
                {inst.strategyName && (
                  <span className="text-muted-foreground text-xs">
                    [{inst.strategyName}]
                  </span>
                )}
              </span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
