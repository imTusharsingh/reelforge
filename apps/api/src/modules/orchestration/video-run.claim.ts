import type { RunsService } from "../runs/runs.service.js";
import { priceShot } from "../usage-budget/run-envelope.js";
import type { RunPaidCalls } from "../usage-budget/run-paid.js";
import { ConflictException } from "@nestjs/common";
import type { ShotSpec } from "@reelforge/contracts";
import { json, type Context, type Run, type Scoped, type Step } from "../runs/runs.types.js";
import { withReceiptBudget } from "../usage-budget/run-shot-receipt.js";
import type { VideoGenPort } from "./video-run.handlers.js";
import { refusalRewrite } from "./video-run.refusal.js";

export async function claimPendingShot(
  db: Scoped,
  step: Step,
  provider: VideoGenPort,
  shot: ShotSpec,
  amount: number,
  estimate: number,
): Promise<void> {
  const rewrite = refusalRewrite(step);
  const claimed = await db.videoRunStep.updateMany({
    where: { id: step.id, state: "PENDING", idempotencyKey: step.idempotencyKey },
    data: {
      state: "RUNNING",
      startedAt: new Date(),
      costMinor: amount,
      providerId: provider.providerId,
      output: withReceiptBudget(
        json({
          ...(rewrite && { refusalRewrite: rewrite }),
          ...(provider.collectionPricing && { videoPricing: provider.collectionPricing(shot) }),
        }),
        { admittedMinor: amount, bufferMinor: amount - estimate, estimateMinor: estimate },
      ),
    },
  });
  if (!claimed.count) throw new ConflictException("Step already claimed");
}
export function shotPort(
  step: Step,
  ports: { primary: VideoGenPort; fallback: VideoGenPort },
): VideoGenPort {
  const registry = new Map([ports.primary, ports.fallback].map((port) => [port.providerId, port]));
  const port = step.providerId ? registry.get(step.providerId) : undefined;
  if (!port) throw new ConflictException("RECONCILE_REQUIRED: stored provider is unavailable");
  return port;
}

export class ShotClaimCanceled extends Error {}

export async function claimShot(
  runs: RunsService,
  paid: RunPaidCalls,
  context: Context,
  run: Run,
  step: Step,
  shot: ShotSpec,
  ports: { primary: VideoGenPort; fallback: VideoGenPort },
): Promise<{ step: Step; provider: VideoGenPort }> {
  const proof = await paid.prepareReservation(run);
  const claim = await runs.store.mutate(
    context,
    run.id,
    "dispatch_reserved",
    async (db, current, tx) => {
      if (current.state === "CANCELED") throw new ShotClaimCanceled();
      if (
        current.state !== "GENERATING" ||
        current.pauseReason === "EMERGENCY_STOP" ||
        current.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
        current.pauseReason === "OPERATOR_ABANDONED"
      )
        throw new ConflictException("Run is not generating");
      const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
      const rewrite = refusalRewrite(step);
      const route = rewrite
        ? shotPort({ ...step, providerId: rewrite.providerId }, ports) === ports.fallback
          ? "FALLBACK"
          : "PRIMARY"
        : budget.route;
      const { provider, amount, estimate } = priceShot(current, { ...budget, route }, ports, shot);
      await claimPendingShot(db, step, provider, shot, amount, estimate);
      await db.budgetEnvelope.updateMany({
        where: { id: budget.id, revision: budget.revision },
        data: { reservedMinor: budget.reservedMinor + amount, revision: budget.revision + 1 },
      });
      const updated = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      await paid.reserve(context, current, updated, amount, tx, proof);
      if (provider.modelId)
        await tx.providerRequest.updateMany({
          where: { workspaceId: context.workspaceId, correlationId: step.id },
          data: { capabilityId: provider.modelId },
        });
      return {
        value: { step: updated, provider },
        payload: { amountMinor: amount },
        stepId: step.id,
      };
    },
  );
  await runs.events?.publish(claim.event);
  return claim.value;
}
