import { z } from "zod";
import {
  AutonomyLevelSchema,
  VideoRunStateSchema,
  VideoRunStepStateSchema,
} from "./foundations.js";

/** V8 integration boundary: missing or malformed gate evidence can never authorize L3. */
export const RunCriticReportSchema = z
  .object({
    recommendation: z.enum(["APPROVE", "REJECT"]),
    summary: z.string().min(1).max(4000),
    gates: z
      .object({
        policy: z.boolean(),
        rights: z.boolean(),
        technical: z.boolean(),
        budget: z.boolean(),
        permission: z.boolean(),
        score: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type RunCriticReport = z.infer<typeof RunCriticReportSchema>;
export const RunDecisionSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]) }).strict();
export const RunAutonomySelectionSchema = z.object({ requested: AutonomyLevelSchema }).strict();
export const RunSummarySchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  state: VideoRunStateSchema,
  requestedAutonomy: AutonomyLevelSchema,
  effectiveAutonomy: AutonomyLevelSchema,
  approvedShortsAtStart: z.int().nonnegative(),
  pauseReason: z.string().nullable(),
});
export const RunSummariesSchema = z.array(RunSummarySchema);
export const SavedCaptionPlanDetailSchema = z.enum(["MALFORMED_PLAN", "CAPTIONS_TOO_LONG"]);
export const RunDetailViewSchema = z.object({
  run: RunSummarySchema,
  steps: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      attempt: z.int(),
      confirmTerminalText: z.boolean().optional(),
      awaitingReconciliation: z.boolean().optional(),
      state: VideoRunStepStateSchema,
      costMinor: z.number().nullable(),
      providerId: z.string().nullable(),
      input: z.unknown(),
      output: z.unknown(),
      error: z.unknown().optional(),
    }),
  ),
  completedStages:z.array(VideoRunStateSchema).optional(),
  remainingBudgetMinor: z.int().nonnegative().optional(),
  pinnedHardCapMinor: z.int().nonnegative().optional(),
  envelope: z
    .object({ spentMinor: z.int(), reservedMinor: z.int().optional(), hardCapMinor: z.int() })
    .nullable(),
  artifactUrls: z.array(
    z.object({
      stepId: z.uuid(),
      artifacts: z.array(
        z.object({
          url: z.string().startsWith("/api/v1/runs/"),
          contentType: z.string(),
          kind: z.string(),
        }),
      ),
    }),
  ),
});
export const RunAutonomyStatusSchema = z.object({
  approvedShorts: z.int(),
  offerL3: z.boolean(),
  effective: AutonomyLevelSchema,
  agreements: z.int(),
  samples: z.int(),
  recommended: z.boolean(),
});
export const EffectiveCapsViewSchema = z
  .array(
    z.object({
      effectiveBriefCaps: z
        .array(
          z.union([z.object({channelId:z.uuid(),name:z.string(),incompatibleCurrencies:z.array(z.string()).min(1)}), z.object({
            channelId: z.uuid(),
            name: z.string(),
            dailyLimitMinor: z.int().nonnegative(),
            monthlyLimitMinor: z.int().nonnegative(),
          })]),
        )
        .optional(),
    }),
  )
  .transform((rows) =>
    Array.from(
      new Map(
        rows.flatMap((row) => row.effectiveBriefCaps ?? []).map((cap) => [cap.channelId, cap]),
      ).values(),
    ),
  );
export const RunUsageSchema = z.object({
  shorts: z.array(z.object({ runId: z.uuid(), costMinor: z.int() })),
  providers: z.array(z.object({ providerId: z.string(), costMinor: z.int() })),
});
export type RunDetailView = z.infer<typeof RunDetailViewSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunAutonomyStatus = z.infer<typeof RunAutonomyStatusSchema>;
export function criticReport(output: unknown): RunCriticReport | null {
  const wrapper = z.object({ result: z.unknown() }).safeParse(output);
  const parsed = RunCriticReportSchema.safeParse(wrapper.success ? wrapper.data.result : output);
  return parsed.success ? parsed.data : null;
}
export function criticGatesPass(report: RunCriticReport | null): boolean {
  return (
    report !== null &&
    report.recommendation === "APPROVE" &&
    Object.values(report.gates).every(Boolean)
  );
}

export function humanGatesPass(report: RunCriticReport | null): boolean {
  return (
    report !== null &&
    report.gates.policy &&
    report.gates.rights &&
    report.gates.technical &&
    report.gates.budget &&
    report.gates.permission
  );
}
