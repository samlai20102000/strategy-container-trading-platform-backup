import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { invokeLLM, listLLMModels } from "../_core/llm";
import { protectedProcedure, router } from "../_core/trpc";
import {
  assertValidRainbowTrendLadderConfig,
  type RainbowTrendLadderBaseLine,
  type RainbowTrendLadderConfig,
} from "../../shared/strategies/rainbowTrendLadder";

const proposalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    rationale: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
    riskWarnings: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
    proposal: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxSpreadPoints: { type: "number" },
        maxSlippagePoints: { type: "number" },
        trailingActivationPct: { type: "number" },
        trailingCallbackPct: { type: "number" },
        trendDeviationPoints: { type: "number" },
        trendBaseLine: { type: "string", enum: ["L1", "L2", "L3", "L4"] },
        maxMarginUsagePct: { type: "number" },
        closeOnMarginBreach: { type: "boolean" },
        reentryWaitNextM30Close: { type: "boolean" },
        martinLayers: {
          type: "array",
          minItems: 8,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              triggerSpacingPct: { type: "number" },
              lotValue: { type: "number" },
              enabled: { type: "boolean" },
            },
            required: ["triggerSpacingPct", "lotValue", "enabled"],
          },
        },
      },
      required: [
        "maxSpreadPoints",
        "maxSlippagePoints",
        "trailingActivationPct",
        "trailingCallbackPct",
        "trendDeviationPoints",
        "trendBaseLine",
        "maxMarginUsagePct",
        "closeOnMarginBreach",
        "reentryWaitNextM30Close",
        "martinLayers",
      ],
    },
  },
  required: ["summary", "rationale", "riskWarnings", "proposal"],
} as const;

type RawProposal = {
  summary: string;
  rationale: string[];
  riskWarnings: string[];
  proposal: {
    maxSpreadPoints: number;
    maxSlippagePoints: number;
    trailingActivationPct: number;
    trailingCallbackPct: number;
    trendDeviationPoints: number;
    trendBaseLine: RainbowTrendLadderBaseLine;
    maxMarginUsagePct: number;
    closeOnMarginBreach: boolean;
    reentryWaitNextM30Close: boolean;
    martinLayers: Array<{
      triggerSpacingPct: number;
      lotValue: number;
      enabled: boolean;
    }>;
  };
};

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function buildSafetyBoundProposal(current: RainbowTrendLadderConfig, raw: RawProposal): RainbowTrendLadderConfig {
  const candidateLayers = Array.isArray(raw.proposal.martinLayers) ? raw.proposal.martinLayers : [];
  const martinLayers = current.Martin_Layers.map((layer, index) => {
    if (index === 0) return { ...layer, enabled: true, triggerSpacingPct: 0 };
    const candidate = candidateLayers[index];
    if (!candidate) return { ...layer };
    return {
      ...layer,
      // AI 不得縮短加倉距離、放大單層手數或重新開啟已停用層。
      triggerSpacingPct: Math.max(layer.triggerSpacingPct, finite(candidate.triggerSpacingPct, layer.triggerSpacingPct)),
      lotValue: Math.min(layer.lotValue, Math.max(0.00000001, finite(candidate.lotValue, layer.lotValue))),
      enabled: layer.enabled ? candidate.enabled === true : false,
    };
  });

  return assertValidRainbowTrendLadderConfig({
    ...current,
    Max_Spread_Points: Math.min(current.Max_Spread_Points, Math.max(0.00000001, finite(raw.proposal.maxSpreadPoints, current.Max_Spread_Points))),
    Max_Slippage_Points: Math.min(current.Max_Slippage_Points, Math.max(0, finite(raw.proposal.maxSlippagePoints, current.Max_Slippage_Points))),
    Trailing_Activation_Pct: Math.min(100, Math.max(0.00000001, finite(raw.proposal.trailingActivationPct, current.Trailing_Activation_Pct))),
    Trailing_Callback_Pct: Math.min(
      Math.min(100, Math.max(0.00000001, finite(raw.proposal.trailingActivationPct, current.Trailing_Activation_Pct))),
      Math.max(0.00000001, finite(raw.proposal.trailingCallbackPct, current.Trailing_Callback_Pct)),
    ),
    Trend_Deviation_Points: Math.min(current.Trend_Deviation_Points, Math.max(0.00000001, finite(raw.proposal.trendDeviationPoints, current.Trend_Deviation_Points))),
    Trend_Base_Line: ["L1", "L2", "L3", "L4"].includes(raw.proposal.trendBaseLine)
      ? raw.proposal.trendBaseLine
      : current.Trend_Base_Line,
    Max_Margin_Usage_Pct: Math.min(current.Max_Margin_Usage_Pct, Math.max(0.00000001, finite(raw.proposal.maxMarginUsagePct, current.Max_Margin_Usage_Pct))),
    Close_On_Margin_Breach: raw.proposal.closeOnMarginBreach !== false,
    Reentry_Wait_Next_M30_Close: raw.proposal.reentryWaitNextM30Close !== false,
    Martin_Layers: martinLayers,
    // 每一份 AI 提案都強制回到未武裝，且不可移除帳戶／KILL 隔離。
    Require_Dedicated_Account: true,
    Kill_Close_Only_Owned_Position: true,
    Live_Trading_Armed: false,
  });
}

function collectChanges(current: RainbowTrendLadderConfig, proposed: RainbowTrendLadderConfig) {
  const changes: Array<{ path: string; before: string; after: string }> = [];
  const compare = (path: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ path, before: String(before), after: String(after) });
    }
  };
  compare("Max_Spread_Points", current.Max_Spread_Points, proposed.Max_Spread_Points);
  compare("Max_Slippage_Points", current.Max_Slippage_Points, proposed.Max_Slippage_Points);
  compare("Trailing_Activation_Pct", current.Trailing_Activation_Pct, proposed.Trailing_Activation_Pct);
  compare("Trailing_Callback_Pct", current.Trailing_Callback_Pct, proposed.Trailing_Callback_Pct);
  compare("Trend_Deviation_Points", current.Trend_Deviation_Points, proposed.Trend_Deviation_Points);
  compare("Trend_Base_Line", current.Trend_Base_Line, proposed.Trend_Base_Line);
  compare("Max_Margin_Usage_Pct", current.Max_Margin_Usage_Pct, proposed.Max_Margin_Usage_Pct);
  compare("Close_On_Margin_Breach", current.Close_On_Margin_Breach, proposed.Close_On_Margin_Breach);
  compare("Reentry_Wait_Next_M30_Close", current.Reentry_Wait_Next_M30_Close, proposed.Reentry_Wait_Next_M30_Close);
  compare("Live_Trading_Armed", current.Live_Trading_Armed, proposed.Live_Trading_Armed);
  proposed.Martin_Layers.forEach((layer, index) => {
    const before = current.Martin_Layers[index];
    compare(`Martin_Layers.${index}.triggerSpacingPct`, before?.triggerSpacingPct, layer.triggerSpacingPct);
    compare(`Martin_Layers.${index}.lotValue`, before?.lotValue, layer.lotValue);
    compare(`Martin_Layers.${index}.enabled`, before?.enabled, layer.enabled);
  });
  return changes;
}

export const rainbowTrendLadderAiRouter = router({
  proposeConfig: protectedProcedure
    .input(z.object({
      objective: z.string().trim().min(10, "請至少描述 10 個字的優化目標").max(2_000),
      currentConfig: z.unknown(),
    }))
    .mutation(async ({ input }) => {
      const current = assertValidRainbowTrendLadderConfig(input.currentConfig);
      try {
        const models = await listLLMModels();
        const preferred = ["gpt-5-mini", "claude-haiku-4-5", "gemini-3-flash-preview"];
        const model = preferred.find((id) => models.data.some((item) => item.id === id)) ?? models.data[0]?.id;
        if (!model) throw new Error("目前沒有可用的內建模型");

        const response = await invokeLLM({
          model,
          maxTokens: 1_800,
          responseFormat: {
            type: "json_schema",
            json_schema: { name: "rainbow_trend_ladder_safe_proposal", strict: true, schema: proposalSchema },
          },
          messages: [
            {
              role: "system",
              content: [
                "你是七彩虹線趨勢跟蹤階梯馬丁策略的風險優先參數研究顧問，不是投資顧問。",
                "你只能根據使用者提供的目標與目前 V1 設定提出研究假設，不得聲稱可獲利、不得預測市場、不得建議立即實盤。",
                "不得改變七條 SMA、M30/M1 週期、底倉、初始資金、策略身份、專用帳戶限制、KILL 所有權限制或實盤武裝。",
                "不得縮短任何加倉間距、增加任何層手數、重新開啟已停用層、放寬點差／滑點／保證金上限。",
                "每項建議都必須說明需要回測、走勢外樣本與模擬盤驗證；若資訊不足，保持目前值。",
              ].join("\n"),
            },
            {
              role: "user",
              content: `優化目標：\n${input.objective}\n\n目前 V1 設定：\n${JSON.stringify(current, null, 2)}`,
            },
          ],
        });

        const text = extractText(response.choices[0]?.message.content);
        if (!text) throw new Error("模型沒有回傳設定提案");
        const raw = JSON.parse(text) as RawProposal;
        const proposedConfig = buildSafetyBoundProposal(current, raw);
        return {
          model: response.model || model,
          summary: raw.summary,
          rationale: raw.rationale,
          riskWarnings: [
            ...raw.riskWarnings,
            "這是參數研究提案，不構成投資建議；未完成回測、走勢外驗證與模擬盤前不可實盤啟用。",
          ],
          safetyEnforced: [
            "不修改七線、M30/M1、底倉、策略身份或 20415",
            "不縮短加倉距離、不放大手數、不重新啟用已停用層",
            "不放寬點差、滑點或保證金上限",
            "提案固定 Live_Trading_Armed=false，不能啟用策略或解除 KILL",
          ],
          changedFields: collectChanges(current, proposedConfig),
          proposedConfig,
        };
      } catch (error) {
        console.error("[RainbowTrendLadderAI] 產生安全提案失敗", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? `AI 建議產生失敗：${error.message}` : "AI 建議產生失敗",
        });
      }
    }),
});

