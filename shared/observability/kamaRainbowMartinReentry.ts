export type KamaRainbowMartinEntryKind =
  | "initial"
  | "same_direction_reentry"
  | "reverse_direction_reentry";

export type KamaRainbowMartinReentryState =
  | "disabled"
  | "killed"
  | "position_open"
  | "awaiting_reentry"
  | "awaiting_initial_entry";

export interface KamaRainbowMartinEntryEvent {
  kind: KamaRainbowMartinEntryKind;
  cycleNumber: number;
  sameDirectionEntrySequence: number;
  side: "long" | "short";
  previousCloseReason: string | null;
  occurredAt: number;
  fillId: string;
  orderId: string | null;
}

export interface KamaRainbowMartinReentryObservation {
  strategyId: number;
  enabled: boolean;
  state: KamaRainbowMartinReentryState;
  cycleNumber: number;
  sameDirectionEntrySequence: number;
  lastEntrySide: "long" | "short" | null;
  lastCloseReason: string | null;
  lastEntryEvent: KamaRainbowMartinEntryEvent | null;
  source: "s1_runtime" | "position_ledger" | "no_execution_evidence";
}
