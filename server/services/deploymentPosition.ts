export type DeploymentPositionMode = "quantity" | "usdt";

export interface DeploymentPosition {
  value: number;
  mode: DeploymentPositionMode;
}

interface StoredPositionSource {
  positionSize?: unknown;
  positionMode?: unknown;
  positionSizeObject?: unknown;
}

function positiveFinite(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positionMode(value: unknown): DeploymentPositionMode | undefined {
  return value === "quantity" || value === "usdt" ? value : undefined;
}

function positionObject(value: unknown): Partial<DeploymentPosition> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return {
    value: positiveFinite(raw.value),
    mode: positionMode(raw.mode),
  };
}

/**
 * 建立／編輯輸入的嚴格部署倉位契約。
 * 策略專用配置中的 Base_Lot_Size 不得覆蓋此值。
 */
export function createDeploymentPosition(
  value: unknown,
  mode: unknown,
): DeploymentPosition {
  const normalizedValue = positiveFinite(value);
  const normalizedMode = positionMode(mode);
  if (normalizedValue === undefined) {
    throw new Error("實盤倉位大小必須為大於 0 的有限數值");
  }
  if (!normalizedMode) {
    throw new Error("實盤倉位單位必須為 quantity 或 usdt");
  }
  return { value: normalizedValue, mode: normalizedMode };
}

/**
 * 讀取既有策略的部署倉位。頂層欄位為正式來源；舊資料只有在頂層缺失或
 * 無效時才回退到 positionSizeObject，最後才使用明確傳入的安全預設值。
 */
export function resolveDeploymentPosition(
  source: StoredPositionSource,
  fallback: DeploymentPosition,
): DeploymentPosition {
  const legacyObject = positionObject(source.positionSizeObject);
  return {
    value: positiveFinite(source.positionSize) ?? legacyObject.value ?? fallback.value,
    mode: positionMode(source.positionMode) ?? legacyObject.mode ?? fallback.mode,
  };
}

/** 將部署倉位同步寫入三個持久化欄位，避免值與單位再次分叉。 */
export function deploymentPositionColumns(position: DeploymentPosition) {
  return {
    positionSize: String(position.value),
    positionMode: position.mode,
    positionSizeObject: { ...position },
  };
}

/**
 * 為使用數字 Base_Lot_Size 的策略建立本次執行有效配置；只回傳新物件，
 * 絕不修改或回寫快照原始配置。
 */
export function withNumericDeploymentBaseLot<T extends Record<string, unknown>>(
  config: T,
  position: DeploymentPosition,
): T & Record<string, unknown> {
  return {
    ...config,
    Base_Lot_Size: position.value,
    Position_Mode: position.mode,
    Position_Value: position.value,
  };
}

/** 為 20415 物件型 Base_Lot_Size 建立本次執行有效配置。 */
export function withObjectDeploymentBaseLot<T extends Record<string, unknown>>(
  config: T,
  position: DeploymentPosition,
): T & Record<string, unknown> {
  return {
    ...config,
    Base_Lot_Size: { ...position },
    Position_Mode: position.mode,
    Position_Value: position.value,
  };
}
