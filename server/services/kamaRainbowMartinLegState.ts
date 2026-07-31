import type { PositionLeg } from "../../drizzle/schema";
import {
  createKamaRainbowMartinRuntimeState,
  type KamaRainbowMartinRuntimeState,
} from "../strategies/kamaRainbowMartin/core";

type KamaRainbowMartinLegStateSource = Pick<
  PositionLeg,
  "side" | "quantity" | "avgEntryPrice" | "martinState"
>;

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Rehydrates the strategy runtime from the position-leg ledger.
 *
 * Quantity and average entry price are ledger truth. totalCost is derived from
 * those two values instead of trusting a stale or missing serialized runtime
 * field; otherwise the next martingale fill can calculate a corrupt average.
 */
export function restoreKamaRainbowMartinLegState(
  leg: KamaRainbowMartinLegStateSource,
): KamaRainbowMartinRuntimeState {
  const seed = leg.martinState && typeof leg.martinState === "object"
    ? leg.martinState as Partial<KamaRainbowMartinRuntimeState>
    : {};
  const totalSize = finiteNonNegative(leg.quantity);
  const avgPrice = finiteNonNegative(leg.avgEntryPrice ?? seed.avgPrice);
  return createKamaRainbowMartinRuntimeState({
    ...seed,
    isLong: leg.side === "LONG",
    currentLayer: Math.max(1, Number(seed.currentLayer || 1)),
    totalSize,
    avgPrice,
    totalCost: totalSize * avgPrice,
  });
}
