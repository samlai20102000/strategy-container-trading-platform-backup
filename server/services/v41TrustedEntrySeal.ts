import crypto from "node:crypto";

import {
  V41_CONFIG_VERSION,
  V41_STRATEGY_KEY,
} from "../../shared/strategies/kama3kMartinV41";
import type {
  V41EntryDirection,
  V41EntryEvaluationResult,
} from "../strategies/v41/entryConditions";

const V41_SEAL_VERSION = 1 as const;

export interface V41TrustedEntrySealClaims {
  sealVersion: typeof V41_SEAL_VERSION;
  strategyId: number;
  strategyKey: typeof V41_STRATEGY_KEY;
  configVersion: typeof V41_CONFIG_VERSION;
  configHash: string;
  action: "buy" | "sell";
  direction: V41EntryDirection;
  barTimestamp: number;
  decisionClose: number;
  fastKama: number | null;
  slowKama: number | null;
  issuedAt: number;
}

export interface V41TrustedEntrySeal {
  claims: V41TrustedEntrySealClaims;
  signature: string;
}

export interface V41TrustedEntrySealVerification {
  valid: boolean;
  reason: string;
  claims: V41TrustedEntrySealClaims | null;
}

function getSealKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET 未配置，V4.1 可信封印 fail-closed");
  }
  return crypto.createHash("sha256").update(`v41-entry-seal:${secret}`).digest();
}

function serializeClaims(claims: V41TrustedEntrySealClaims): string {
  return JSON.stringify([
    claims.sealVersion,
    claims.strategyId,
    claims.strategyKey,
    claims.configVersion,
    claims.configHash,
    claims.action,
    claims.direction,
    claims.barTimestamp,
    claims.decisionClose,
    claims.fastKama,
    claims.slowKama,
    claims.issuedAt,
  ]);
}

function signClaims(claims: V41TrustedEntrySealClaims): string {
  return crypto.createHmac("sha256", getSealKey()).update(serializeClaims(claims)).digest("hex");
}

function safeSignatureEqual(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function createV41TrustedEntrySeal(input: {
  strategyId: number;
  action: "buy" | "sell";
  evaluation: V41EntryEvaluationResult;
  issuedAt?: number;
}): V41TrustedEntrySeal {
  const { evaluation } = input;
  if (
    evaluation.decision !== "open"
    || !evaluation.passed
    || !evaluation.direction
    || !evaluation.configHash
    || !isFiniteNumber(evaluation.decisionClose)
    || !isFiniteNumber(evaluation.decisionBarTimestamp)
    || evaluation.decisionBarTimestamp <= 0
  ) {
    throw new Error("V4.1 只有通過 canonical evaluator 的完整 closed-bar 決策可以建立可信封印");
  }
  const expectedAction = evaluation.direction === "long" ? "buy" : "sell";
  if (input.action !== expectedAction) {
    throw new Error("V4.1 封印方向與 evaluator 決策不一致");
  }

  const claims: V41TrustedEntrySealClaims = {
    sealVersion: V41_SEAL_VERSION,
    strategyId: input.strategyId,
    strategyKey: V41_STRATEGY_KEY,
    configVersion: V41_CONFIG_VERSION,
    configHash: evaluation.configHash,
    action: input.action,
    direction: evaluation.direction,
    barTimestamp: evaluation.decisionBarTimestamp,
    decisionClose: evaluation.decisionClose,
    fastKama: evaluation.fastKama,
    slowKama: evaluation.slowKama,
    issuedAt: input.issuedAt ?? Date.now(),
  };
  return { claims, signature: signClaims(claims) };
}

export function verifyV41TrustedEntrySeal(input: {
  seal: unknown;
  strategyId: number;
  action: "buy" | "sell";
  barTimestamp: number | undefined;
  expectedConfigHash: string;
  maxAgeMs: number;
  now?: number;
}): V41TrustedEntrySealVerification {
  const seal = input.seal as Partial<V41TrustedEntrySeal> | null;
  const claims = seal?.claims as Partial<V41TrustedEntrySealClaims> | undefined;
  if (!claims || !seal?.signature) {
    return { valid: false, reason: "缺少 V4.1 伺服器內部可信封印", claims: null };
  }
  if (
    claims.sealVersion !== V41_SEAL_VERSION
    || claims.strategyKey !== V41_STRATEGY_KEY
    || claims.configVersion !== V41_CONFIG_VERSION
    || claims.strategyId !== input.strategyId
    || claims.action !== input.action
    || claims.direction !== (input.action === "buy" ? "long" : "short")
    || claims.configHash !== input.expectedConfigHash
    || !isFiniteNumber(claims.barTimestamp)
    || claims.barTimestamp !== input.barTimestamp
    || !isFiniteNumber(claims.decisionClose)
    || !isFiniteNumber(claims.issuedAt)
  ) {
    return { valid: false, reason: "V4.1 封印 claims 與目前策略／配置／方向／決策 K 不一致", claims: null };
  }
  const completeClaims = claims as V41TrustedEntrySealClaims;
  const expectedSignature = signClaims(completeClaims);
  if (!safeSignatureEqual(expectedSignature, seal.signature)) {
    return { valid: false, reason: "V4.1 封印 HMAC 簽章無效", claims: null };
  }
  const now = input.now ?? Date.now();
  const age = now - completeClaims.issuedAt;
  if (age < -60_000 || age > input.maxAgeMs) {
    return { valid: false, reason: `V4.1 封印已過期或時間異常（age=${age}ms）`, claims: null };
  }
  return { valid: true, reason: "V4.1 HMAC 可信封印有效", claims: completeClaims };
}

