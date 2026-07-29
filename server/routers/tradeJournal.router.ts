import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import {
  preflightTradeJournalExport,
  queryTradeJournal,
  summarizeTradeJournal,
} from "../services/tradeJournalQuery";
import {
  EmptyTradeReportError,
  generateAndStoreTradeReport,
} from "../services/tradeReportGenerator";

export const tradeJournalFiltersSchema = z.object({
  strategyId: z.number().int().positive().optional(),
  strategyIds: z.array(z.number().int().positive()).max(200).optional(),
  status: z.enum(["received", "executed", "failed", "rejected", "skipped"]).optional(),
  source: z.enum(["webhook", "auto", "manual"]).optional(),
  action: z.enum(["buy", "sell", "close"]).optional(),
  symbol: z.string().trim().min(1).max(32).optional(),
  pnlState: z.enum(["known", "pending", "unresolved", "not_applicable"]).optional(),
  startTime: z.date().optional(),
  endTime: z.date().optional(),
}).superRefine((input, ctx) => {
  if (input.startTime && input.endTime && input.startTime > input.endTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endTime"],
      message: "結束時間不可早於開始時間",
    });
  }
});

const tradeJournalPageSchema = tradeJournalFiltersSchema.and(z.object({
  limit: z.number().int().min(1).max(5_000).default(50),
  offset: z.number().int().min(0).default(0),
}));

const tradeReportGenerateSchema = tradeJournalFiltersSchema.and(z.object({
  format: z.enum(["xlsx", "csv"]),
  confirmLargeExport: z.boolean().default(false),
  confirmationToken: z.string().length(24).optional(),
}));

export const tradeJournalRouter = router({
  list: protectedProcedure
    .input(tradeJournalPageSchema)
    .query(({ ctx, input }) => queryTradeJournal(ctx.user.id, input)),

  summary: protectedProcedure
    .input(tradeJournalFiltersSchema)
    .query(({ ctx, input }) => summarizeTradeJournal(ctx.user.id, input)),

  preflight: protectedProcedure
    .input(tradeJournalFiltersSchema)
    .query(({ ctx, input }) => preflightTradeJournalExport(ctx.user.id, input)),

  generateReport: protectedProcedure
    .input(tradeReportGenerateSchema)
    .mutation(async ({ ctx, input }) => {
      const preflight = await preflightTradeJournalExport(ctx.user.id, input);
      if (preflight.totalRows === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "目前篩選條件沒有可匯出的交易資料，未建立空白檔案。",
        });
      }
      if (preflight.requiresConfirmation && (
        !input.confirmLargeExport || input.confirmationToken !== preflight.confirmationToken
      )) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "資料量較大，請先檢視最新預檢結果並明確確認後再生成。",
        });
      }
      try {
        const report = await generateAndStoreTradeReport({
          userId: ctx.user.id,
          format: input.format,
          filters: input,
        });
        return { report, preflight };
      } catch (error) {
        if (error instanceof EmptyTradeReportError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
        }
        throw error;
      }
    }),
});
