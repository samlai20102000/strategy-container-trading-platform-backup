/**
 * 格式化已實現／未實現盈虧。
 * 一般金額維持兩位小數；小於 0.01 的非零金額保留最多六位，
 * 避免真實小額盈虧被顯示成 0.00。
 */
export function formatPnlAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.01) {
    return value.toFixed(6).replace(/\.?0+$/, "");
  }
  return value.toFixed(2);
}
