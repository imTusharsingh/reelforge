import { ConflictException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { pinnedBudget } from "./run-envelope.js";
import { z } from "zod";
import type { RunsStore } from "../runs/runs.store.js";
import {
  billingHold,
  SETTLED_SHOTS,
  clearResolvedSubmissionHold,
  failSettledGeneration,
} from "../runs/run-outcomes.js";
import {
  ArtifactSchema,
  json,
  type Artifact,
  type Context,
  type Json,
  type Run,
  type Scoped,
  type Step,
  type Transaction,
} from "../runs/runs.types.js";
import {
  BILLING_OVERAGE,
  DISPATCHING,
  OUTCOME_UNKNOWN,
  isBillingHold,
  readAdmission,
  type Admission,
} from "./run-admission-state.js";
import type { RunPaidCalls } from "./run-paid.js";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";

const pricedOutput = z.object({
  receipt: z.object({ providerJobId: z.string().min(1), costMinor: z.int().nonnegative() }),
});
export function awaitingBilling(step: Step): boolean {
  return isBillingHold(step.error);
}

const pendingOutput = z.object({
  pendingMedia: z
    .object({
      objectKey: z.string(),
      checksumSha256: z.string(),
      byteSize: z.number(),
      mimeType: z.string(),
      durationSeconds: z.number(),
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      billedSeconds: z.number().nullable(),
    })
    .nullable(),
  receipt: pricedOutput.shape.receipt.extend({
    key: z.string(),
    providerId: z.string(),
    seconds: z.number(),
    providerDurationSeconds: z.number().nullable(),
    modelId: z.string(),
    promptVersion: z.string(),
  }),
});

export function pendingShotMedia(step: Step): z.infer<typeof pendingOutput> | null {
  if (!step.output || typeof step.output !== "object" || !("pendingMedia" in step.output))
    return null;
  const saved = pendingOutput.parse(step.output);
  if (
    saved.receipt.providerJobId !== step.providerJobId ||
    saved.receipt.providerId !== step.providerId
  )
    throw new ConflictException("Stored receipt does not match shot");
  return saved;
}

function unpaidReservation(
  run: Run,
  step: Step,
  { request, reservation }: Admission,
  cost: number,
): Admission["reservation"] {
  const priorJob = z.object({ providerJobId: z.string() }).safeParse(request?.responseMetadata);
  if (priorJob.success && priorJob.data.providerJobId !== step.providerJobId)
    throw new ConflictException("Provider job receipt changed");
  if (
    !reservation ||
    reservation.correlationId !== step.id ||
    reservation.channelId !== run.channelId ||
    !step.providerJobId ||
    !step.providerId ||
    reservation.currency !== "USD" ||
    (request && (request.currency !== reservation.currency || request.channelId !== run.channelId))
  )
    throw new ConflictException("Billing receipt does not match the paid attempt");
  if (reservation.status === "COMMITTED") {
    if (
      request?.status === "SUCCEEDED" &&
      request.errorCode === null &&
      request.actualCost?.mul(100).equals(cost) &&
      reservation.committedMinor === BigInt(cost)
    )
      return null;
    throw new ConflictException("Receipt differs from committed payment");
  }
  return reservation;
}

async function savePricedRequest(
  tx: Transaction,
  context: Context,
  run: Run,
  step: Step,
  receipt: VideoReceipt,
  previousCost: number | undefined,
  paid: RunPaidCalls,
): Promise<void> {
  const { workspaceId, channelId } = run;
  const claim = await readAdmission(tx, context, step);
  const cost = receipt.costMinor;
  const reservation = unpaidReservation(run, step, claim, cost);
  if (!reservation) return;
  const { request } = claim;
  await paid.usage.coverShotReceipt(tx, workspaceId, channelId, reservation, cost);
  const overage = cost > (step.costMinor ?? 0);
  const data = {
    status: "SUCCEEDED" as const,
    errorCode: overage ? BILLING_OVERAGE : null,
    actualCost: new Prisma.Decimal(cost).div(100),
    responseMetadata: { providerJobId: step.providerJobId!, dispatched: true, costKnown: true },
  };
  if (!request) {
    await tx.providerRequest.create({
      data: {
        workspaceId,
        channelId,
        correlationId: step.id,
        providerId: step.providerId!,
        capabilityId: receipt.modelId,
        createdAt: reservation.createdAt,
        currency: reservation.currency,
        estimatedCost: new Prisma.Decimal(
          (step.costMinor ?? reservation.amountMinor).toString(),
        ).div(100),
        ...data,
      },
    });
    return;
  }
  const saved = await tx.providerRequest.updateMany({
    where: {
      id: request.id,
      workspaceId: run.workspaceId,
      ...(previousCost === undefined
        ? { errorCode: { in: [DISPATCHING, OUTCOME_UNKNOWN] } }
        : {
            status: "SUCCEEDED",
            errorCode: previousCost > (step.costMinor ?? 0) ? BILLING_OVERAGE : null,
            actualCost: new Prisma.Decimal(previousCost).div(100),
          }),
    },
    data,
  });
  if (saved.count !== 1) throw new ConflictException("Billing claim changed");
}

function shotIdentity(step: Step): Pick<Step, "key" | "providerJobId" | "providerId"> {
  const { key, providerId, providerJobId } = step;
  return { key, providerId, providerJobId };
}

function mergeShotReceipt(
  step: Step,
  receipt: VideoReceipt,
): {
  output: Json;
  cost: number;
  previousCost: number | undefined;
  higher: boolean;
} | null {
  const pending = pendingShotMedia(step);
  const { media, ...price } = receipt;
  if (!pending && awaitingBilling(step)) {
    // Another collector may already have written the final clip while settlement is pending.
    const final = z
      .object({
        receipt: pricedOutput.shape.receipt.passthrough(),
        storageArtifacts: z.array(ArtifactSchema).min(1),
      })
      .parse(step.output);
    if (final.receipt.providerJobId !== step.providerJobId)
      throw new ConflictException("Stored receipt does not match shot");
    const previousCost = final.receipt.costMinor;
    if (price.costMinor <= previousCost) return null;
    return {
      higher: true,
      previousCost,
      cost: price.costMinor,
      output: json({
        ...final,
        receipt: {
          ...final.receipt,
          costMinor: price.costMinor,
          seconds: price.seconds,
          modelId: price.modelId,
          promptVersion: price.promptVersion,
        },
      }),
    };
  }
  const higher = !pending || price.costMinor > pending.receipt.costMinor;
  if (!higher && !media) return null;
  const pendingMedia = media ?? pending?.pendingMedia ?? null;
  const output = pendingOutput.parse({
    pendingMedia,
    receipt: {
      ...(higher ? price : pending.receipt),
      ...shotIdentity(step),
      providerDurationSeconds: pendingMedia?.durationSeconds ?? null,
    },
  });
  return {
    higher,
    previousCost: pending?.receipt.costMinor,
    cost: output.receipt.costMinor,
    output,
  };
}

/** Keep the highest reported charge and the latest staged media for the accepted job. */
export async function captureShotReceipt(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  receipt: VideoReceipt,
): Promise<Step> {
  const result = await store.mutate(
    context,
    step.runId,
    "provider_receipt",
    async (db, run, tx) => {
      const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      if (current.providerJobId !== step.providerJobId || !step.providerJobId)
        throw new ConflictException("Provider job claim changed");
      if (current.state === "SUCCEEDED") {
        if (receipt.costMinor > (current.costMinor ?? 0))
          throw new ConflictException("Receipt exceeds settled payment");
        return { value: current, payload: { replay: true } };
      }
      if (current.state !== "WAITING_EXTERNAL")
        throw new ConflictException("Provider job claim changed");
      const merged = mergeShotReceipt(current, receipt);
      if (!merged) return { value: current, payload: { replay: true } };
      const { higher, previousCost, output, cost } = merged;
      const overage = cost > (current.costMinor ?? 0);
      if (higher) await savePricedRequest(tx, context, run, current, receipt, previousCost, paid);
      await db.videoRunStep.updateMany({
        where: { id: step.id },
        data: { output, ...(overage && { error: { code: BILLING_OVERAGE } }) },
      });
      if (higher && overage && run.pauseReason !== "EMERGENCY_STOP")
        await db.videoRun.updateMany({
          where: { id: run.id },
          data: { pauseReason: billingHold(step.id) },
        });
      return {
        value: await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } }),
        payload: { costMinor: cost, overage },
        stepId: step.id,
      };
    },
  );
  return result.value;
}

/** Recovery consumes the immutable receipt, never another poll, fetch or price lookup. */
export async function reconcilePricedReceipt(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
): Promise<void> {
  await store.mutate(context, step.runId, "billing_reconciled", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (current.state === "SUCCEEDED") return { value: null, payload: { replay: true } };
    const claim = await readAdmission(tx, context, current);
    const { receipt } = pricedOutput.parse(current.output);
    const cost = receipt.costMinor;
    if (
      claim.evidence !== "billing-overage" ||
      !awaitingBilling(current) ||
      !z.object({ storageArtifacts: z.array(ArtifactSchema).min(1) }).safeParse(current.output)
        .success ||
      current.state !== "WAITING_EXTERNAL" ||
      receipt.providerJobId !== current.providerJobId ||
      !claim.request?.actualCost?.mul(100).equals(cost)
    )
      throw new ConflictException("Stored billing evidence changed");
    await settleReceipt(db, tx, paid, context, run, current, cost, current.output as Json);
    const reserved = current.costMinor ?? 0;
    return { value: null, payload: { costMinor: cost, reservedMinor: reserved }, stepId: step.id };
  });
}

async function settleReceipt(
  db: Scoped,
  tx: Transaction,
  paid: RunPaidCalls,
  context: Context,
  run: Run,
  step: Step,
  cost: number,
  output: Json,
): Promise<void> {
  const reserved = step.costMinor ?? 0;
  await paid.commitJob(tx, context, step, cost);
  const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
  await db.budgetEnvelope.updateMany({
    where: { id: budget.id },
    data: {
      reservedMinor: budget.reservedMinor - reserved,
      spentMinor: budget.spentMinor + cost,
      overageMinor: budget.overageMinor + Math.max(0, cost - reserved),
      revision: budget.revision + 1,
    },
  });
  await db.videoRunStep.updateMany({
    where: { id: step.id },
    data: {
      state: "SUCCEEDED",
      costMinor: cost,
      finishedAt: new Date(),
      output,
      error: Prisma.DbNull,
    },
  });
  const pauseReason = await clearResolvedSubmissionHold(db, tx, run, step.id);
  await failSettledGeneration(db, { ...run, pauseReason });
}

export async function recordShotArtifact(
  store: RunsStore,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  artifact: Artifact,
): Promise<{ value: boolean; event: import("../runs/runs.types.js").Event }> {
  return store.mutate(context, step.runId, "step_completed", async (db, run, tx) => {
    const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (SETTLED_SHOTS.some((state) => state === current.state))
      return { value: false, payload: { replay: true } };
    if (
      current.state !== "WAITING_EXTERNAL" ||
      current.providerJobId !== step.providerJobId ||
      !current.providerJobId
    )
      throw new ConflictException("Provider job claim changed");
    const reserved = current.costMinor ?? 0;
    const pending = pendingShotMedia(current);
    if (awaitingBilling(current) && !pending) return { value: false, payload: { replay: true } };
    const cost = pending?.receipt.costMinor ?? reserved;
    const output = json({
      storageArtifacts: [artifact],
      ...(pending && {
        receipt: {
          ...pending.receipt,
          objectKey: artifact.objectKey,
          checksumSha256: artifact.checksumSha256,
          mimeType: "video/mp4",
        },
      }),
    });

    if (cost > reserved) {
      await db.videoRunStep.updateMany({ where: { id: step.id }, data: { output } });
      return {
        value: false,
        eventType: "reconcile_required",
        stepId: step.id,
        payload: { reason: billingHold(step.id), costMinor: cost },
      };
    }
    await settleReceipt(db, tx, paid, context, run, current, cost, output);
    const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    return {
      value: true,
      stepId: step.id,
      payload: { costMinor: cost, warn: budget.spentMinor > pinnedBudget(run).targetMinor },
    };
  });
}
