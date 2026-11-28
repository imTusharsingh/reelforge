import { terminalVideo } from "./run-video-terminal.js";
import { pendingCorrection } from "./run-pending-receipt.js";
import type { Prisma } from "@reelforge/database";
import { pendingShotMedia } from "./run-shot-receipt.js";
import { lockBooks } from "./text-admission-lock.js";
import { ConflictException } from "@nestjs/common";
import type { Context, Step, Transaction } from "../runs/runs.types.js";
import { json } from "../runs/runs.types.js";
import {
  BILLING_OVERAGE,
  canConfirmRejection,
  DISPATCHING,
  OUTCOME_UNKNOWN,
  readAdmission,
} from "./run-admission-state.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

type Failure = {
  message: string;
  dispatched: boolean;
  cost: number;
  providerJobId: string | null;
  usage?: Record<string, unknown>;
};
export async function settleFailedRequest(
  ledger: Pick<UsageBudgetService, "commit" | "release">,
  tx: Transaction,
  context: Context,
  step: Step,
  { message, dispatched, cost, providerJobId, usage }: Failure,
): Promise<number> {
  if (step.key.startsWith("media:text:"))
    throw new ConflictException("Text settlement requires its evidence journal");
  if (!dispatched && !canConfirmRejection(await readAdmission(tx, context, step)))
    throw new ConflictException("Paid dispatch outcome changed");
  // Billing can be staged before a second poll reports terminal failure. Match
  // that staged posting to the exact job before replacing the success ledger state.
  const staged = stagedShotBill(step, providerJobId, dispatched);
  const recorded = terminalVideo(step);
  const highest = Math.max(
    staged?.costBasis === "BILLED" ? staged.costMinor : -1,
    recorded && recorded.providerJobId === providerJobId ? (recorded.billedMinor ?? -1) : -1,
    step.key.startsWith("shot-") && dispatched ? (pendingCorrection(step)?.costMinor ?? -1) : -1,
  );
  const billed = highest === -1 ? null : highest;
  await lockFailureBooks(tx, context.workspaceId, step.runId, billed);
  const charged = billed ?? cost;
  const code =
    usage !== undefined
      ? "PROVIDER_INVALID_OUTPUT"
      : dispatched
        ? "PROVIDER_JOB_FAILED"
        : "NOT_DISPATCHED";
  const updated = await tx.providerRequest.updateMany({
    where: {
      workspaceId: context.workspaceId,
      correlationId: step.id,
      OR: [
        { errorCode: dispatched ? { in: [DISPATCHING, OUTCOME_UNKNOWN] } : DISPATCHING },
        ...stagedPosting(staged?.costMinor, providerJobId),
      ],
    },
    data: {
      status: "FAILED",
      actualCost: dispatched ? (billed === null ? null : (billed / 100).toFixed(2)) : 0,
      ...(usage !== undefined ? { usage: json(usage) } : {}),
      responseMetadata: {
        dispatched,
        costKnown: !dispatched || billed !== null,
        ...(providerJobId && providerJobId !== step.idempotencyKey ? { providerJobId } : {}),
      },
      errorCode: code,
      errorMessage: message,
    },
  });
  if (updated.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
  const reservation = await tx.usageReservation.findFirstOrThrow({
    where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
  });
  if (dispatched) await ledger.commit(context.workspaceId, reservation.id, charged, tx);
  else await ledger.release(context.workspaceId, reservation.id, code, tx);
  return charged;
}

function stagedShotBill(
  step: Step,
  providerJobId: string | null,
  dispatched: boolean,
): NonNullable<ReturnType<typeof pendingShotMedia>>["receipt"] | undefined {
  return dispatched &&
    step.key.startsWith("shot-") &&
    step.state === "WAITING_EXTERNAL" &&
    !!providerJobId &&
    providerJobId === step.providerJobId
    ? pendingShotMedia(step)?.receipt
    : undefined;
}

function stagedPosting(
  costMinor: number | undefined,
  providerJobId: string | null,
): Prisma.ProviderRequestWhereInput[] {
  if (costMinor === undefined || !providerJobId) return [];
  return [
    {
      status: "SUCCEEDED",
      OR: [{ errorCode: null }, { errorCode: BILLING_OVERAGE }],
      actualCost: (costMinor / 100).toFixed(2),
      responseMetadata: { path: ["providerJobId"], equals: providerJobId },
    },
  ];
}

async function lockFailureBooks(
  tx: Transaction,
  workspaceId: string,
  runId: string,
  billed: number | null,
): Promise<void> {
  if (billed === null) return;
  const run = await tx.videoRun.findUniqueOrThrow({
    where: { workspaceId, id: runId },
    select: { channelId: true },
  });
  await lockBooks(tx, { workspaceId, channelId: run.channelId });
}
