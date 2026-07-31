import type {
  DeploymentActivationState,
  ExecutionMode,
} from "@shared/executionModes";

export type WorkbenchLifecycleAction =
  | "PREFLIGHT"
  | "ACTIVATE"
  | "PAUSE"
  | "RESUME"
  | "DRAIN"
  | "DISABLE"
  | "BLOCK"
  | "ARCHIVE";

export const DEPLOYMENT_MODE_META: Readonly<Record<ExecutionMode, {
  code: "S1" | "M2" | "H3";
  label: string;
  shortDescription: string;
  accent: string;
}>> = Object.freeze({
  SINGLE_EXCLUSIVE: {
    code: "S1",
    label: "單倉互斥",
    shortDescription: "同一部署僅保留一個方向腿",
    accent: "border-sky-500/35 bg-sky-500/10 text-sky-300",
  },
  MULTI_POSITION: {
    code: "M2",
    label: "雙向獨立",
    shortDescription: "LONG／SHORT 各一腿且狀態隔離",
    accent: "border-violet-500/35 bg-violet-500/10 text-violet-300",
  },
  HEDGE_GUARDED: {
    code: "H3",
    label: "保護對沖",
    shortDescription: "雙條件觸發的受限保護腿",
    accent: "border-amber-500/35 bg-amber-500/10 text-amber-300",
  },
});

export const DEPLOYMENT_STATE_META: Readonly<Record<DeploymentActivationState, {
  label: string;
  tone: string;
  description: string;
}>> = Object.freeze({
  LEGACY: {
    label: "LEGACY 相容",
    tone: "border-slate-500/40 bg-slate-500/10 text-slate-300",
    description: "既有 S1 相容路徑，尚未轉入 canonical lifecycle。",
  },
  DRAFT: {
    label: "草稿",
    tone: "border-slate-500/40 bg-slate-500/10 text-slate-300",
    description: "部署已建立但尚未完成只讀預檢。",
  },
  DISABLED: {
    label: "已停用",
    tone: "border-slate-500/40 bg-slate-500/10 text-slate-300",
    description: "不接受新曝險，需重新預檢才可啟用。",
  },
  PREFLIGHT_FAILED: {
    label: "預檢封鎖",
    tone: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    description: "一個或多個安全 Gate 未通過。",
  },
  READY_DISABLED: {
    label: "預檢通過／待啟用",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    description: "最新 revision 已通過預檢，但仍保持停用。",
  },
  ARMED: {
    label: "已武裝／待啟用",
    tone: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
    description: "相容過渡狀態，需明確操作才進入 ACTIVE。",
  },
  ACTIVE: {
    label: "執行中",
    tone: "border-emerald-500/45 bg-emerald-500/15 text-emerald-200",
    description: "允許通過 mode/risk Gate 的新曝險與減曝。",
  },
  PAUSED: {
    label: "已暫停／僅減曝",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    description: "禁止新曝險，既有腿僅允許 reduce／close。",
  },
  DRAINING: {
    label: "排空中／僅減曝",
    tone: "border-orange-500/40 bg-orange-500/10 text-orange-300",
    description: "停止開倉並持續安全關閉既有曝險。",
  },
  BLOCKED: {
    label: "風控封鎖",
    tone: "border-rose-500/45 bg-rose-500/15 text-rose-200",
    description: "Fail-closed 維運狀態，只允許降低風險。",
  },
  ARCHIVED: {
    label: "已封存",
    tone: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
    description: "不可再啟用的歷史部署。",
  },
});

const ACTIONS_BY_STATE: Readonly<Record<DeploymentActivationState, readonly WorkbenchLifecycleAction[]>> =
  Object.freeze({
    LEGACY: ["DISABLE"],
    DRAFT: ["PREFLIGHT", "DISABLE", "BLOCK", "ARCHIVE"],
    DISABLED: ["PREFLIGHT", "BLOCK", "ARCHIVE"],
    PREFLIGHT_FAILED: ["PREFLIGHT", "DISABLE", "BLOCK", "ARCHIVE"],
    READY_DISABLED: ["PREFLIGHT", "ACTIVATE", "DISABLE", "BLOCK", "ARCHIVE"],
    ARMED: ["ACTIVATE", "DISABLE", "BLOCK"],
    ACTIVE: ["PAUSE", "DRAIN", "BLOCK"],
    PAUSED: ["PREFLIGHT", "RESUME", "DRAIN", "DISABLE", "BLOCK"],
    DRAINING: ["DISABLE", "BLOCK"],
    BLOCKED: ["PREFLIGHT", "DRAIN", "DISABLE", "ARCHIVE"],
    ARCHIVED: [],
  });

export function getWorkbenchLifecycleActions(
  state: DeploymentActivationState,
): readonly WorkbenchLifecycleAction[] {
  return ACTIONS_BY_STATE[state] ?? [];
}

export function canSwitchDeploymentMode(
  state: DeploymentActivationState,
  enabled: boolean,
): boolean {
  return !enabled && [
    "DRAFT",
    "DISABLED",
    "PREFLIGHT_FAILED",
    "READY_DISABLED",
    "PAUSED",
    "BLOCKED",
  ].includes(state);
}

export function isFreshEligiblePreflight(
  report: { eligible?: boolean; expiresAt?: number } | null | undefined,
  now = Date.now(),
): boolean {
  return report?.eligible === true
    && Number.isFinite(report.expiresAt)
    && Number(report.expiresAt) >= now;
}

export function buildDeploymentTransitionKey(
  action: string,
  deploymentId: number,
  uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
): string {
  const safeAction = action.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 24) || "transition";
  return `${safeAction}-${deploymentId}-${uuid}`.slice(0, 96);
}

export const DEPLOYMENT_SAFETY_COPY = Object.freeze({
  defaultDisabled: "建立、複製與模式切換後一律保持停用；系統不會自動啟用實盤。",
  readonlyPreflight: "Preflight 只使用交易所唯讀能力、商品、餘額與持倉查詢，不送單、不撤單、不改變 position mode。",
  closeOnly: "PAUSED／DRAINING／BLOCKED 禁止新增曝險，僅允許 reduce／close。",
});
