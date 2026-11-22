import { ConflictException } from "@nestjs/common";
import { reservationCents } from "@reelforge/ai-providers";
import { clipMoney, overheadCents } from "../scene-media/media-prices.js";
import {
  BudgetPolicySchema,
  type ChannelBrief,
  type BudgetEnvelope,
  type ShotSpec,
} from "@reelforge/contracts";

import { z } from "zod";
import type { Run, Scoped } from "../runs/runs.types.js";

const snapshotPolicy = z.object({ brief: z.object({ budgetPolicy: BudgetPolicySchema }) });
export function pinnedBudget(run: Run): ChannelBrief["budgetPolicy"] {
  const { budgetPolicy } = snapshotPolicy.parse(run.inputSnapshot).brief;
  const hardCapMinor = Math.min(800, budgetPolicy.hardCapMinor);
  return {
    ...budgetPolicy,
    hardCapMinor,
    targetMinor: Math.min(budgetPolicy.targetMinor, hardCapMinor),
  };
}

export function shotReceiptBufferMinor(estimateMinor: number): number {
  if (!Number.isSafeInteger(estimateMinor) || estimateMinor < 0)
    throw new Error("Invalid shot estimate");
  return Math.ceil(estimateMinor / 4);
}

/** Include paid work performed before envelope creation, and pre-existing envelopes with old defaults. */
export async function assertRunCap(
  db: Scoped,
  run: Run,
  amount: number,
  excludingStepId?: string,
): Promise<number> {
  const claims = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      state: { notIn: ["SKIPPED", "CANCELLED"] },
      ...(excludingStepId ? { id: { not: excludingStepId } } : {}),
    },
    select: { state: true, costMinor: true, output: true },
  });
  const cumulative = claims.reduce((total, claim) => {
    const receiptBudget = z
      .object({ receiptBudget: z.object({ bufferMinor: z.number().int().nonnegative() }) })
      .passthrough()
      .safeParse(claim.output);
    return (
      total +
      (claim.costMinor ?? 0) +
      (claim.state === "SUCCEEDED" && receiptBudget.success
        ? receiptBudget.data.receiptBudget.bufferMinor
        : 0)
    );
  }, amount);
  if (cumulative > pinnedBudget(run).hardCapMinor)
    throw new ConflictException({ code: "BUDGET_CAP", message: "BUDGET_CAP" });
  return cumulative;
}

export type Estimate = Pick<BudgetEnvelope, "baseEstimateMinor" | "reshootReserveMinor" | "route">;
export function clipEstimate(
  shots: readonly (Pick<ShotSpec, "durationSeconds"> &
    Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>)[],
  fallback: boolean,
): number {
  return shots.reduce((sum, shot) => sum + reservationCents(clipMoney(shot, fallback)), 0);
}
export function runEstimate(
  shots: readonly (Pick<ShotSpec, "durationSeconds"> &
    Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>)[],
  fallback = false,
  hardCapMinor = 800,
): Estimate {
  const clips = clipEstimate(shots, fallback);
  const overhead = overheadCents(shots);
  const baseEstimateMinor = clips + overhead;
  if (baseEstimateMinor > hardCapMinor)
    throw new ConflictException({
      code: "BUDGET_CAP",
      message:
        hardCapMinor === 800 ? "Run estimate exceeds $8" : "Run estimate exceeds the pinned cap",
    });
  return {
    baseEstimateMinor,
    reshootReserveMinor: Math.min(Math.ceil(clips / 2), hardCapMinor - baseEstimateMinor),
    route: fallback ? "FALLBACK" : "PRIMARY",
  };
}
export function fallbackEstimate(
  envelope: Pick<BudgetEnvelope, "spentMinor" | "reservedMinor" | "reshootReserveMinor">,
  remaining: readonly (Pick<ShotSpec, "durationSeconds"> &
    Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>)[],
  overheadRemaining = 0,
  hardCapMinor = 800,
): Estimate {
  const clips = clipEstimate(remaining, true);
  const buffer = remaining.reduce(
    (sum, shot) => sum + shotReceiptBufferMinor(reservationCents(clipMoney(shot, true))),
    0,
  );
  const baseEstimateMinor =
    envelope.spentMinor + envelope.reservedMinor + clips + buffer + overheadRemaining;
  if (baseEstimateMinor > hardCapMinor)
    throw new ConflictException({ code: "BUDGET_CAP", message: "Fallback exceeds the run cap" });
  const reserve =
    baseEstimateMinor + envelope.reshootReserveMinor <= hardCapMinor
      ? envelope.reshootReserveMinor
      : 0;
  return { baseEstimateMinor, reshootReserveMinor: reserve, route: "FALLBACK" };
}
export function envelopeRoom(
  envelope: Pick<
    BudgetEnvelope,
    "baseEstimateMinor" | "reshootReserveMinor" | "spentMinor" | "reservedMinor" | "hardCapMinor"
  >,
  amount: number,
): boolean {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid minor-unit amount");
  return (
    envelope.spentMinor + envelope.reservedMinor + amount <=
    Math.min(envelope.hardCapMinor, envelope.baseEstimateMinor + envelope.reshootReserveMinor)
  );
}
