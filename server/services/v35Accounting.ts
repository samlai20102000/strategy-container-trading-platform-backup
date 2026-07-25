export interface V35RealizedPnlInput {
  exitPrice: number;
  avgPrice: number;
  totalSize: number;
  isLong: boolean;
}

/**
 * 計算 V35/V4 平倉已實現盈虧（未扣交易所手續費）。
 * 缺少可信成交價、均價或數量時回傳 undefined，避免寫入虛假 0。
 */
export function calculateV35RealizedPnl({
  exitPrice,
  avgPrice,
  totalSize,
  isLong,
}: V35RealizedPnlInput): number | undefined {
  if (
    !Number.isFinite(exitPrice) ||
    !Number.isFinite(avgPrice) ||
    !Number.isFinite(totalSize) ||
    exitPrice <= 0 ||
    avgPrice <= 0 ||
    totalSize <= 0
  ) {
    return undefined;
  }

  const directionMultiplier = isLong ? 1 : -1;
  return (exitPrice - avgPrice) * totalSize * directionMultiplier;
}
