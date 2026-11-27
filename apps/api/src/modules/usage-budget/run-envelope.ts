import { assertSavedCaptionAdmission } from "./run-caption-admission.js";
import type { VideoGenPort } from "../orchestration/video-run.handlers.js";
import { pendingCorrection } from "./run-pending-receipt.js";
import { readReceiptBudget } from "./run-shot-receipt.js";
import { ConflictException } from "@nestjs/common";
import { reservationCents } from "@reelforge/ai-providers";
import { clipMoney, plannedRunOverheadCents } from "../scene-media/media-prices.js";
import {
  BudgetPolicySchema,
  type ChannelBrief,
  type BudgetEnvelope,
  type ShotSpec,
} from "@reelforge/contracts";

import { z } from "zod";
import type { Run, Scoped, Step } from "../runs/runs.types.js";

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

/** Include paid work performed before envelope creation, and pre-existing envelopes with old defaults. */
export async function assertPaidRunLimits(
  db: Scoped,
  run: Run,
  amount: number,
  excludingStepId?: string,
): Promise<number> {
  const claims = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      state: { not: "CANCELLED" },
      ...(excludingStepId ? { id: { not: excludingStepId } } : {}),
    },
  });
  await assertSavedCaptionAdmission(db, run, claims);
  const cumulative = amount + claimedRunCost(claims);
  if (cumulative > pinnedBudget(run).hardCapMinor)
    throw new ConflictException({ code: "BUDGET_CAP", message: "BUDGET_CAP" });
  return cumulative;
}

export function claimedRunCost(steps: Step[]): number {
  return steps.reduce((total, claim) => {
    if (claim.state === "CANCELLED") return total;
    const retained = claim.state === "SUCCEEDED" ? readReceiptBudget(claim.output)?.bufferMinor : 0;
    const covered = (claim.costMinor ?? 0) + (retained ?? 0);
    return total + Math.max(covered, pendingCorrection(claim)?.costMinor ?? 0);
  }, 0);
}

export type Estimate = Pick<BudgetEnvelope, "baseEstimateMinor" | "reshootReserveMinor" | "route">;
type PlanShot = Pick<ShotSpec, "durationSeconds"> &
  Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>;

export function shotReceiptBufferMinor(estimateMinor: number): number {
  if (!Number.isSafeInteger(estimateMinor) || estimateMinor < 0)
    throw new Error("Invalid shot estimate");
  return Math.ceil(estimateMinor / 4);
}

function clipCoverage(
  shots: readonly PlanShot[],
  fallback: boolean,
): {
  clipsMinor: number;
  receiptBufferMinor: number;
} {
  let clipsMinor = 0;
  let receiptBufferMinor = 0;
  for (const shot of shots) {
    const quote = reservationCents(clipMoney(shot, fallback));
    clipsMinor += quote;
    receiptBufferMinor += shotReceiptBufferMinor(quote);
  }
  return { clipsMinor, receiptBufferMinor };
}

export function runEstimate(
  shots: readonly PlanShot[],
  fallback = false,
  hardCapMinor = 800,
  planningSpentMinor?: number,
): Estimate & { expectedSpendMinor: number; receiptBufferMinor: number } {
  const { clipsMinor, receiptBufferMinor } = clipCoverage(shots, fallback);
  const expectedSpendMinor = clipsMinor + plannedRunOverheadCents(shots, planningSpentMinor);
  const baseEstimateMinor = expectedSpendMinor + receiptBufferMinor;
  if (baseEstimateMinor > hardCapMinor)
    throw new ConflictException({
      code: "BUDGET_CAP",
      message:
        hardCapMinor === 800 ? "Run estimate exceeds $8" : "Run estimate exceeds the pinned cap",
    });
  return {
    baseEstimateMinor,
    expectedSpendMinor,
    receiptBufferMinor,
    reshootReserveMinor: Math.min(Math.ceil(clipsMinor / 2), hardCapMinor - baseEstimateMinor),
    route: fallback ? "FALLBACK" : "PRIMARY",
  };
}
export function fallbackEstimate(
  envelope: Pick<BudgetEnvelope, "spentMinor" | "reservedMinor" | "reshootReserveMinor">,
  remaining: readonly PlanShot[],
  overheadRemaining = 0,
  hardCapMinor = 800,
): Estimate {
  const { clipsMinor, receiptBufferMinor } = clipCoverage(remaining, true);
  const baseEstimateMinor =
    envelope.spentMinor +
    envelope.reservedMinor +
    clipsMinor +
    receiptBufferMinor +
    overheadRemaining;
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

export function priceShot(
  current: Run,
  budget: Parameters<typeof envelopeRoom>[0] & Pick<BudgetEnvelope, "route">,
  ports: { primary: VideoGenPort; fallback: VideoGenPort },
  shot: ShotSpec,
): { provider: VideoGenPort; amount: number; estimate: number } {
  const provider = budget.route === "FALLBACK" ? ports.fallback : ports.primary;
  provider.assertKey?.();
  const estimate = provider.estimate(shot, budget.route === "FALLBACK");
  const amount = estimate + shotReceiptBufferMinor(estimate);
  if (
    !envelopeRoom(
      {
        ...budget,
        hardCapMinor: Math.min(budget.hardCapMinor, pinnedBudget(current).hardCapMinor),
      },
      amount,
    )
  )
    throw new ConflictException({ code: "BUDGET_CAP", message: "Envelope exhausted" });
  return { provider, amount, estimate };
}
