import { ConflictException } from "@nestjs/common";
import type { ShotSpec } from "@reelforge/contracts";
import { json, type Scoped, type Step } from "../runs/runs.types.js";
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
