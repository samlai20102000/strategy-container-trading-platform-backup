import type { EquityPoint } from "./performanceCalculator";

function finiteEquity(point: EquityPoint): number {
  return Number.isFinite(point.equity) ? point.equity : 0;
}

function findMaximumDrawdownAnchors(points: EquityPoint[]): {
  peakIndex: number;
  troughIndex: number;
} {
  let peakEquity = Math.max(0, finiteEquity(points[0]));
  let peakIndex = 0;
  let maxDrawdown = -1;
  let maxDrawdownPeakIndex = 0;
  let maxDrawdownTroughIndex = 0;

  for (let index = 0; index < points.length; index += 1) {
    const boundedEquity = Math.max(0, finiteEquity(points[index]));
    if (boundedEquity > peakEquity) {
      peakEquity = boundedEquity;
      peakIndex = index;
    }

    const drawdown = peakEquity > 0
      ? (peakEquity - boundedEquity) / peakEquity
      : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPeakIndex = peakIndex;
      maxDrawdownTroughIndex = index;
    }
  }

  return {
    peakIndex: maxDrawdownPeakIndex,
    troughIndex: maxDrawdownTroughIndex,
  };
}

/**
 * 權益曲線的風險感知降採樣。
 *
 * 一般點仍採等距保留，但下列風險錨點永遠不可被抽掉：
 * - 首點與尾點
 * - 全期間最高／最低權益
 * - 產品定義下最大回撤的峰值與谷值
 * - 首次非正權益、其前一點，以及破產後首次恢復為正的點
 *
 * `regularPointLimit=2000` 延續舊契約，最多回傳 2,001 點。
 */
export function downsampleEquityCurve(
  points: EquityPoint[],
  regularPointLimit: number,
): EquityPoint[] {
  if (points.length === 0) return [];

  const normalizedLimit = Math.max(1, Math.floor(regularPointLimit));
  const targetPointCount = Math.min(points.length, normalizedLimit + 1);
  if (points.length <= targetPointCount) return points;

  let minimumIndex = 0;
  let maximumIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    const equity = finiteEquity(points[index]);
    if (equity < finiteEquity(points[minimumIndex])) minimumIndex = index;
    if (equity > finiteEquity(points[maximumIndex])) maximumIndex = index;
  }

  const firstNonPositiveIndex = points.findIndex(
    point => finiteEquity(point) <= 0,
  );
  const firstRecoveryIndex = firstNonPositiveIndex >= 0
    ? points.findIndex(
        (point, index) => index > firstNonPositiveIndex && finiteEquity(point) > 0,
      )
    : -1;
  const drawdownAnchors = findMaximumDrawdownAnchors(points);

  const mandatoryIndices = new Set<number>([
    0,
    points.length - 1,
    minimumIndex,
    maximumIndex,
    drawdownAnchors.peakIndex,
    drawdownAnchors.troughIndex,
  ]);

  if (firstNonPositiveIndex >= 0) {
    mandatoryIndices.add(firstNonPositiveIndex);
    mandatoryIndices.add(Math.max(0, firstNonPositiveIndex - 1));
  }
  if (firstRecoveryIndex >= 0) {
    mandatoryIndices.add(firstRecoveryIndex);
  }

  const selectedIndices = new Set<number>(mandatoryIndices);
  const denominator = Math.max(1, targetPointCount - 1);

  for (let slot = 0; slot < targetPointCount && selectedIndices.size < targetPointCount; slot += 1) {
    selectedIndices.add(
      Math.round((slot * (points.length - 1)) / denominator),
    );
  }

  // 極少數索引碰撞時補足容量；只影響圖表密度，不會移除任何風險錨點。
  for (let index = 0; index < points.length && selectedIndices.size < targetPointCount; index += 1) {
    selectedIndices.add(index);
  }

  return Array.from(selectedIndices)
    .sort((left, right) => left - right)
    .map(index => points[index]);
}
