import { InvalidCompletedScript, isScriptRepair } from "../script/script-repair.js";
import { redactString } from "@reelforge/observability";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { InvalidCompletedText, ProviderFailure } from "@reelforge/ai-providers";
import { z } from "zod";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import { BudgetExhaustedError, BudgetUnresolvableError } from "./usage-budget.types.js";
import { assertCriticRevision } from "./critic-admission.js";
import { envelopeRoom } from "./run-envelope.js";
import { appendTextEvidence, lockTextAttempt, readTextAttempt } from "./text-attempt-store.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { textCancellationRequested } from "./text-attempt-cancel.js";
import { currentTextSenderIdentity } from "./text-sender-identity.js";
import {
  deliverTextObservation,
  spoolTextObservation,
  type TextObservation,
} from "./text-attempt-delivery.js";

const sender = currentTextSenderIdentity();
const preparedInput = z.object({
  expectedRevision: z.int(),
  stage: z.string(),
  modelId: z.string(),
  estimateMinor: z.int().positive(),
  dispatchKey: z.string().min(1),
  input: z.json(),
});
export const paidTextEnabled = (): boolean => process.env.PAID_TEXT_V3_ENABLED === "1";

export type PaidTextResult<T = unknown> = {
  output: T;
  dispatchKey: string;
  providerJobId: string | null;
  usage: Record<string, unknown>;
};
export type PaidTextInvocation<T> = (onBodySent: () => Promise<void>) => Promise<PaidTextResult<T>>;

export async function dispatchPaidText<T>(
  access: MediaAccess,
  context: Context,
  step: Step,
  invoke: PaidTextInvocation<T>,
): Promise<PaidTextResult<T>> {
  const nonce = randomUUID();
  let armedStage: Run["state"];
  try {
    if (!paidTextEnabled()) throw new ServiceUnavailableException("Paid text dispatch is disabled");
    const run = await access.runs.store.get(context, step.runId);
    const proof = await access.paid.prepareReservation(run);
    await access.boundary.check(context, run);
    armedStage = await authorizeTextArm(access, context, step, nonce, proof);
  } catch (error) {
    // Treat every unacknowledged arm as a lost permission, even if its transaction committed.
    const reason = preDispatchRefusal(error, step);
    await surrenderTextArm(access, context, step, nonce, true, reason);
    throw error;
  }
  try {
    const current = await access.runs.store.get(context, step.runId);
    if (current.pauseReason === textCancellationRequested)
      throw new ConflictException("Cancellation was requested before transport");
    if (current.state !== armedStage || current.pauseReason !== null)
      throw new ConflictException("Paid text admission changed before transport");
    await access.boundary.check(context, current);
  } catch (error) {
    await surrenderTextArm(access, context, step, nonce, false);
    throw error;
  }
  return observeInvocation(access, context, step, nonce, invoke);
}

function preDispatchRefusal(error: unknown, step: Step): string | undefined {
  if (
    error instanceof ServiceUnavailableException &&
    error.message === "Paid text dispatch is disabled"
  )
    return error.message;
  if (!isScriptRepair(step)) return;
  if (error instanceof BudgetExhaustedError || error instanceof BudgetUnresolvableError)
    return error.code;
  if (error instanceof ServiceUnavailableException && error.message === "Budget policy unavailable")
    return error.message;
  if (
    error instanceof ConflictException &&
    ["BUDGET_CAP", "Paid text envelope cannot cover the attempt"].includes(error.message)
  )
    return "BUDGET_CAP";
  return "Script repair admission refused before dispatch";
}

async function authorizeTextArm(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
  proof: Awaited<ReturnType<MediaAccess["paid"]["prepareReservation"]>>,
): Promise<Run["state"]> {
  const result = await access.runs.store.mutate(
    context,
    step.runId,
    "text_attempt_armed",
    async (db, run, tx) => {
      const current = await lockTextAttempt(tx, context.workspaceId, step.id);
      const prepared = await tx.textAttemptEvidence.findFirst({
        where: { workspaceId: context.workspaceId, attemptId: step.id, kind: "PREPARED" },
      });
      const decoded = preparedInput.safeParse(prepared?.data);
      const prior = await readTextAttempt(tx, current);
      await assertCriticRevision(db, tx, run, current);
      if (
        !decoded.success ||
        prior?.armNonce ||
        prior?.phase !== "PREPARED" ||
        current.idempotencyKey !== step.idempotencyKey ||
        decoded.data.dispatchKey !== current.idempotencyKey ||
        !isDeepStrictEqual(decoded.data.input, current.input) ||
        current.state !== "RUNNING" ||
        run.revision !== decoded.data.expectedRevision ||
        run.state !== decoded.data.stage ||
        run.pauseReason !== null
      )
        throw new ConflictException("Paid text admission changed");
      await access.boundary.assertNotStopped(context, run);
      const amount = decoded.data.estimateMinor;
      const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
      if (budget && (budget.currency !== "USD" || !envelopeRoom(budget, amount)))
        throw new ConflictException("Paid text envelope cannot cover the attempt");
      const reservation = await access.paid.reserve(context, run, current, amount, tx, proof);
      await tx.providerRequest.updateMany({
        where: { workspaceId: context.workspaceId, correlationId: current.id },
        data: { providerId: "gemini", capabilityId: decoded.data.modelId },
      });
      await appendTextEvidence(tx, current, {
        eventKey: "arm",
        kind: "ARMED",
        nonce,
        data: {
          dispatchKey: step.idempotencyKey,
          reservationId: reservation.reservationId,
          incarnation: sender.incarnation,
          sender,
        },
      });
      await foldTextAttempt(tx, context, step.id);
      return { value: run.state, payload: { dispatchKey: step.idempotencyKey }, stepId: step.id };
    },
  );
  return result.value;
}

export async function refuseTextPreparation(
  access: MediaAccess,
  context: Context,
  step: Step,
  error: unknown,
): Promise<never> {
  const reason = redactString(error instanceof Error ? error.message : String(error)).slice(0, 512);
  await surrenderTextArm(
    access,
    context,
    step,
    randomUUID(),
    true,
    reason || "Text port lookup failed",
  );
  throw error;
}

async function surrenderTextArm(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
  closeUnarmed: boolean,
  reason?: string,
): Promise<void> {
  const observation: TextObservation = {
    kind: "NOT_DISPATCHED",
    data: {
      dispatchKey: step.idempotencyKey,
      source: "sender",
      senderNonce: nonce,
      ...(reason && { reason }),
    },
  };
  // If the arm transaction rolled back, recovery cannot discover its invocation nonce.
  // Only an unarmed preparation probes this second location.
  for (let attempt = 1; ; attempt++) {
    try {
      if (
        !(await deliverTextObservation(access, context, step, nonce, observation)) &&
        closeUnarmed
      )
        await spoolTextObservation(access, context, step, "prepared", observation);
      return;
    } catch (error) {
      if (attempt === 3 || error instanceof ConflictException) throw error;
    }
  }
}

async function observeInvocation<T>(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
  invoke: PaidTextInvocation<T>,
): Promise<PaidTextResult<T>> {
  const observe = (observation: TextObservation): Promise<boolean> =>
    deliverTextObservation(access, context, step, nonce, observation);
  let handoff: Promise<void> | undefined;
  let result: PaidTextResult<T> | undefined;
  let failure: unknown;
  try {
    result = await invoke(
      () =>
        (handoff ??= observe({
          kind: "SENT_EVIDENCE",
          data: { dispatchKey: step.idempotencyKey, source: "transport" },
        }).then(() => undefined)),
    );
  } catch (error) {
    failure = error;
  }
  if (!handoff && failure instanceof ProviderFailure && !failure.dispatched && !failure.http) {
    await surrenderTextArm(access, context, step, nonce, false, failure.message);
    throw failure;
  }
  if (result && result.dispatchKey !== step.idempotencyKey)
    throw new ConflictException("Text response dispatch key does not match its attempt");
  const observation = result
    ? completedObservation(step, result)
    : failureObservation(step, failure);
  const retired: TextObservation = {
    kind: "SENDER_RETIRED",
    data: { dispatchKey: step.idempotencyKey, ...(observation && { after: observation.kind }) },
  };
  if (observation && !(await observe(observation))) {
    await spoolTextObservation(access, context, step, nonce, retired);
  } else {
    if (!observation) await handoff?.catch(() => undefined);
    await observe(retired);
  }
  if (result) {
    const projected = await access.runs.store.db.textAttemptProjection.findUnique({
      where: { workspaceId_attemptId: { workspaceId: context.workspaceId, attemptId: step.id } },
    });
    const current = await access.runs.store.scoped(context).videoRunStep.findFirst({
      where: { id: step.id, state: { in: ["WAITING_EXTERNAL", "SUCCEEDED"] } },
    });
    if (!projected || !current)
      throw new ConflictException("Text response is saved but settlement is pending");
    return result;
  }
  throw failure ?? new ConflictException("Text submission outcome is unresolved");
}

function completedObservation<T>(step: Step, result: PaidTextResult<T>): TextObservation {
  return {
    kind: "SUCCEEDED",
    data: json({
      dispatchKey: step.idempotencyKey,
      usable: true,
      output: result.output,
      googleId: result.providerJobId,
      usage: result.usage,
    }),
  };
}

function failureObservation(step: Step, failure: unknown): TextObservation | null {
  const dispatchKey = step.idempotencyKey;
  if (failure instanceof InvalidCompletedText)
    return {
      kind: "SUCCEEDED",
      data: json({
        dispatchKey,
        usable: false,
        ...(failure instanceof InvalidCompletedScript && {
          validationError: failure.validationError,
        }),
        googleId: failure.providerJobId,
        usage: failure.usage,
      }),
    };
  if (failure instanceof ProviderFailure && !failure.dispatched && failure.http)
    return {
      kind: "REJECTED",
      data: {
        dispatchKey,
        code: failure.http.code ?? `HTTP_${failure.http.status}`,
        httpStatus: failure.http.status,
      },
    };
  return null;
}

export function prepareTextData(
  run: Run,
  step: Step,
  modelId: string,
  estimateMinor: number,
): ReturnType<typeof json> {
  return json({
    expectedRevision: run.revision + 1,
    sender,
    stage: run.state,
    dispatchKey: step.idempotencyKey,
    input: step.input,
    modelId,
    estimateMinor,
    currency: "USD",
  });
}
