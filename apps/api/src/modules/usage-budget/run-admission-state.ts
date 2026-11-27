import { z } from "zod";
import type { Prisma } from "@reelforge/database";
import { scopedTransaction } from "../runs/runs.transaction.js";
import type { Context, Scoped, Step, Transaction } from "../runs/runs.types.js";

export const ADMISSION_ORDERING = "v2-commit-before-dispatch";
export const DISPATCHING = "VIDEO_RUN_DISPATCHING";
export const BILLING_OVERAGE = "VIDEO_RUN_BILLING_OVERAGE";
export const OUTCOME_UNKNOWN = "VIDEO_RUN_OUTCOME_UNKNOWN";

const providerRequestSelect = {
  id: true,
  correlationId: true,
  errorCode: true,
  status: true,
  responseMetadata: true,
  createdAt: true,
  actualCost: true,
  estimatedCost: true,
  channelId: true,
  currency: true,
} satisfies Prisma.ProviderRequestSelect;
type Request = Prisma.ProviderRequestGetPayload<{ select: typeof providerRequestSelect }>;
const usageReservationSelect = {
  id: true,
  idempotencyKey: true,
  correlationId: true,
  channelId: true,
  status: true,
  expiresAt: true,
  amountMinor: true,
  committedMinor: true,
  currency: true,
  createdAt: true,
} satisfies Prisma.UsageReservationSelect;
type Reservation = Prisma.UsageReservationGetPayload<{ select: typeof usageReservationSelect }>;
type Evidence =
  | "never-dispatched"
  | "pending"
  | "rolled-back"
  | "ambiguous"
  | "dispatching"
  | "recorded"
  | "released-nondispatch"
  | "billing-overage";
type Attempt = Pick<Step, "id" | "runId" | "idempotencyKey" | "providerJobId"> &
  Partial<Pick<Step, "error">>;
export type Admission = {
  evidence: Evidence;
  request: Request | null;
  reservation: Reservation | null;
};

const markerSchema = z.object({ idempotencyKey: z.string() });
const receiptSchema = z.object({ providerJobId: z.string().min(1) });

export const textResultSchema = z.object({
  output: z.json(),
  providerJobId: z.string().min(1),
  usage: z.record(z.string(), z.unknown()),
});

export function attachedTextResult(
  step: Pick<Step, "output" | "providerJobId" | "idempotencyKey">,
): z.infer<typeof textResultSchema> | null {
  const result = textResultSchema.safeParse(step.output);
  return result.success &&
    (result.data.providerJobId === step.providerJobId ||
      result.data.providerJobId === step.idempotencyKey)
    ? result.data
    : null;
}

function classify(
  request: Request | null,
  reservation: Reservation | null,
  marked: boolean,
  jobId: string | null,
): Evidence {
  const dispatched = !!jobId || marked;
  if (!request) return dispatched || reservation ? "ambiguous" : "never-dispatched";
  if (request.errorCode === BILLING_OVERAGE) return "billing-overage";
  if (
    ["NOT_DISPATCHED", "OPERATOR_ABANDONED", "CRITIC_SUPERSEDED"].includes(
      request.errorCode ?? "",
    ) &&
    request.status === "FAILED" &&
    (!request.actualCost || request.actualCost.isZero()) &&
    (reservation?.status === "RELEASED" ||
      (reservation?.status === "EXPIRED" &&
        !marked &&
        request.errorCode === "NOT_DISPATCHED" &&
        z
          .object({
            admissionOrdering: z.literal(ADMISSION_ORDERING),
            costKnown: z.literal(true),
            stepId: z.literal(request.correlationId),
          })
          .safeParse(request.responseMetadata).success)) &&
    !jobId &&
    !receiptSchema.safeParse(request.responseMetadata).success &&
    z.object({ dispatched: z.literal(false) }).safeParse(request.responseMetadata).success
  )
    return "released-nondispatch";
  if (request.errorCode === DISPATCHING) return "dispatching";
  if (request.errorCode !== "PENDING" && request.errorCode !== "ADMISSION_ROLLED_BACK")
    return "recorded"; // Includes OUTCOME_UNKNOWN and provider receipts. Reconcile by the original key.
  const metadata = request.responseMetadata;
  if (
    dispatched ||
    (request.actualCost && !request.actualCost.isZero()) ||
    request.status === "SUCCEEDED" ||
    reservation?.status === "COMMITTED" ||
    receiptSchema.safeParse(metadata).success ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.dispatched !== false ||
    metadata.admissionOrdering !== ADMISSION_ORDERING
  )
    return "ambiguous";
  return request.errorCode === "PENDING" ? "pending" : "rolled-back";
}

export function isBillingHold(error: unknown): boolean {
  return z.object({ code: z.literal(BILLING_OVERAGE) }).safeParse(error).success;
}

export function hasSettledCharge(admission: Admission): boolean {
  return (
    admission.evidence === "recorded" &&
    admission.request?.status === "SUCCEEDED" &&
    admission.request.errorCode === null &&
    admission.reservation?.status === "COMMITTED"
  );
}

export function terminalTextEligible(step: Step, admission: Admission): boolean {
  return (
    step.state === "RUNNING" &&
    step.key.startsWith("media:text:") &&
    !step.providerJobId &&
    !jobIdFromAdmission(admission) &&
    admission.request?.errorCode === OUTCOME_UNKNOWN &&
    !!admission.reservation &&
    ["RESERVED", "EXPIRED"].includes(admission.reservation.status) &&
    admission.reservation.amountMinor === BigInt(step.costMinor ?? -1)
  );
}

export function canRollback({ evidence }: Admission): boolean {
  return evidence === "never-dispatched" || evidence === "pending" || evidence === "rolled-back";
}

export function canConfirmRejection(admission: Admission): boolean {
  return (
    admission.evidence === "dispatching" &&
    !jobIdFromAdmission(admission) &&
    (!admission.request?.actualCost || admission.request.actualCost.isZero()) &&
    admission.reservation?.status !== "COMMITTED"
  );
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

const dispatchEvents = [
  "provider_dispatch",
  "provider_submitted",
  "reconcile_required",
  "step_completed",
  "media_completed",
];

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
      select: providerRequestSelect,
    }),
    tx.usageReservation.findMany({
      where: { workspaceId, idempotencyKey: { in: steps.map((s) => `m08:${s.idempotencyKey}`) } },
      select: usageReservationSelect,
    }),
    db.runEvent.findMany({
      where: {
        workspaceId,
        runId: { in: [...new Set(steps.map((step) => step.runId))] },
        stepId: { in: steps.map((step) => step.id) },
        type: { in: dispatchEvents },
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
      evidence: isBillingHold(step.error)
        ? "billing-overage"
        : classify(request, reservation, marked.has(step.id), step.providerJobId),
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
