import { z } from "zod";
import type { Prisma } from "@reelforge/database";
import { scopedTransaction } from "../runs/runs.transaction.js";
import type { Context, Scoped, Step, Transaction } from "../runs/runs.types.js";

export const ADMISSION_ORDERING = "v2-commit-before-dispatch";
export const DISPATCHING = "VIDEO_RUN_DISPATCHING";
export const OUTCOME_UNKNOWN = "VIDEO_RUN_OUTCOME_UNKNOWN";

type Request = Pick<
  Prisma.ProviderRequestGetPayload<object>,
  "id" | "correlationId" | "errorCode" | "responseMetadata" | "createdAt" | "status"
>;
type Reservation = Pick<
  Prisma.UsageReservationGetPayload<object>,
  "id" | "idempotencyKey" | "status" | "expiresAt"
>;
type Evidence =
  "never-dispatched" | "pending" | "rolled-back" | "ambiguous" | "dispatching" | "recorded";
type Attempt = Pick<Step, "id" | "runId" | "idempotencyKey" | "providerJobId">;
type Admission = {
  evidence: Evidence;
  request: Request | null;
  reservation: Reservation | null;
};

const markerSchema = z.object({ idempotencyKey: z.string() });
const receiptSchema = z.object({ providerJobId: z.string().min(1) });

function classify(
  request: Request | null,
  reservation: Reservation | null,
  dispatched: boolean,
): Evidence {
  if (!request) return dispatched || reservation ? "ambiguous" : "never-dispatched";
  if (request.errorCode === DISPATCHING) return "dispatching";
  if (request.errorCode !== "PENDING" && request.errorCode !== "ADMISSION_ROLLED_BACK")
    return "recorded"; // Includes OUTCOME_UNKNOWN and provider receipts. Reconcile by the original key.
  const metadata = request.responseMetadata;
  if (
    dispatched ||
    request.status === "SUCCEEDED" ||
    reservation?.status === "COMMITTED" ||
    receiptSchema.safeParse(metadata).success ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.dispatched === true ||
    metadata.admissionOrdering !== ADMISSION_ORDERING
  )
    return "ambiguous";
  return request.errorCode === "PENDING" ? "pending" : "rolled-back";
}

export function canRollback({ evidence }: Admission): boolean {
  return evidence === "never-dispatched" || evidence === "pending" || evidence === "rolled-back";
}

export function jobIdFromAdmission(admission: Admission): string | null {
  if (canRollback(admission) || admission.evidence === "ambiguous") return null;
  const receipt = receiptSchema.safeParse(admission.request?.responseMetadata);
  return receipt.success ? receipt.data.providerJobId : null;
}

function markedSteps(
  steps: Attempt[],
  markers: { stepId: string | null; payload: Prisma.JsonValue }[],
): Set<string> {
  const keys = new Map(steps.map((step) => [step.id, step.idempotencyKey]));
  const marked = new Set<string>();
  for (const { stepId, payload } of markers) {
    // Older markers identify the step only. They still preclude a zero-cost rollback.
    const key = markerSchema.safeParse(payload);
    if (stepId && (!key.success || keys.get(stepId) === key.data.idempotencyKey))
      marked.add(stepId);
  }
  return marked;
}

export async function readAdmissions<T extends Attempt>(
  db: Scoped,
  tx: Transaction,
  workspaceId: string,
  steps: T[],
): Promise<(Admission & { step: T })[]> {
  if (!steps.length) return [];
  const [requests, reservations, markers] = await Promise.all([
    tx.providerRequest.findMany({
      where: { workspaceId, correlationId: { in: steps.map((s) => s.id) } },
      select: {
        id: true,
        correlationId: true,
        errorCode: true,
        status: true,
        responseMetadata: true,
        createdAt: true,
      },
    }),
    tx.usageReservation.findMany({
      where: { workspaceId, idempotencyKey: { in: steps.map((s) => `m08:${s.idempotencyKey}`) } },
      select: { id: true, idempotencyKey: true, status: true, expiresAt: true },
    }),
    db.runEvent.findMany({
      where: {
        workspaceId,
        runId: { in: [...new Set(steps.map((step) => step.runId))] },
        stepId: { in: steps.map((step) => step.id) },
        type: {
          in: [
            "provider_dispatch",
            "provider_submitted",
            "reconcile_required",
            "step_completed",
            "media_completed",
          ],
        },
      },
      select: { stepId: true, payload: true },
    }),
  ]);
  const byStep = new Map(requests.map((row) => [row.correlationId, row]));
  const byKey = new Map(reservations.map((row) => [row.idempotencyKey, row]));
  const marked = markedSteps(steps, markers);
  return steps.map((step) => {
    const request = byStep.get(step.id) ?? null;
    const reservation = byKey.get(`m08:${step.idempotencyKey}`) ?? null;
    return {
      step,
      request,
      reservation,
      evidence: classify(request, reservation, !!step.providerJobId || marked.has(step.id)),
    };
  });
}

export async function readAdmission(
  tx: Transaction,
  context: Context,
  step: Attempt,
): Promise<Admission> {
  const [admission] = await readAdmissions(
    scopedTransaction(tx, context),
    tx,
    context.workspaceId,
    [step],
  );
  return admission!;
}
