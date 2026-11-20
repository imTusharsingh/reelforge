import { z } from "zod";
import type { Prisma } from "@reelforge/database";
import type { Step, Transaction } from "../runs/runs.types.js";

export const ADMISSION_ORDERING = "v2-commit-before-dispatch";
export const DISPATCHING = "VIDEO_RUN_DISPATCHING";
export const OUTCOME_UNKNOWN = "VIDEO_RUN_OUTCOME_UNKNOWN";

type Request = Pick<
  Prisma.ProviderRequestGetPayload<object>,
  "id" | "correlationId" | "errorCode" | "responseMetadata" | "createdAt"
>;
type Reservation = Pick<
  Prisma.UsageReservationGetPayload<object>,
  "id" | "idempotencyKey" | "status" | "expiresAt"
>;
type Evidence =
  "never-dispatched" | "pending" | "rolled-back" | "ambiguous" | "dispatching" | "recorded";
type Attempt = Pick<Step, "id" | "idempotencyKey">;
type Admission = {
  evidence: Evidence;
  request: Request | null;
  reservation: Reservation | null;
};

function classify(request: Request | null, reservation: Reservation | null): Evidence {
  // Dispatch requires a committed, unexpired reservation for this exact key. If neither
  // row exists, admission never reached the provider. A surviving reservation rules out that proof.
  if (!request) return reservation ? "ambiguous" : "never-dispatched";
  if (request.errorCode === DISPATCHING) return "dispatching";
  if (request.errorCode !== "PENDING" && request.errorCode !== "ADMISSION_ROLLED_BACK")
    return "recorded"; // Includes OUTCOME_UNKNOWN and provider receipts. Reconcile by the original key.
  const metadata = request.responseMetadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.admissionOrdering !== ADMISSION_ORDERING
  )
    return "ambiguous";
  return request.errorCode === "PENDING" ? "pending" : "rolled-back";
}

export function canRollback({ evidence }: Admission): boolean {
  return evidence === "never-dispatched" || evidence === "pending" || evidence === "rolled-back";
}

const receiptSchema = z.object({ providerJobId: z.string().min(1) });

export function jobIdFromAdmission(admission: Admission): string | null {
  if (canRollback(admission) || admission.evidence === "ambiguous") return null;
  const receipt = receiptSchema.safeParse(admission.request?.responseMetadata);
  return receipt.success ? receipt.data.providerJobId : null;
}

export async function readAdmissions<T extends Attempt>(
  tx: Transaction,
  workspaceId: string,
  steps: T[],
): Promise<(Admission & { step: T })[]> {
  if (!steps.length) return [];
  const [requests, reservations] = await Promise.all([
    tx.providerRequest.findMany({
      where: { workspaceId, correlationId: { in: steps.map((s) => s.id) } },
      select: {
        id: true,
        correlationId: true,
        errorCode: true,
        responseMetadata: true,
        createdAt: true,
      },
    }),
    tx.usageReservation.findMany({
      where: { workspaceId, idempotencyKey: { in: steps.map((s) => `m08:${s.idempotencyKey}`) } },
      select: { id: true, idempotencyKey: true, status: true, expiresAt: true },
    }),
  ]);
  const byStep = new Map(requests.map((row) => [row.correlationId, row]));
  const byKey = new Map(reservations.map((row) => [row.idempotencyKey, row]));
  return steps.map((step) => {
    const request = byStep.get(step.id) ?? null;
    const reservation = byKey.get(`m08:${step.idempotencyKey}`) ?? null;
    return { step, request, reservation, evidence: classify(request, reservation) };
  });
}

export async function readAdmission(
  tx: Transaction,
  workspaceId: string,
  step: Attempt,
): Promise<Admission> {
  const [admission] = await readAdmissions(tx, workspaceId, [step]);
  return admission!;
}
