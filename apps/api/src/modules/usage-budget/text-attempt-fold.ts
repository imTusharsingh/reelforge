import { ConflictException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { json, type Context, type Run, type Step, type Transaction } from "../runs/runs.types.js";
import { readTextAttempt, type TextAttemptState } from "./text-attempt-store.js";
import { PLANNING_MANIFEST_KEY, remainingSubmissionHold } from "../runs/run-outcomes.js";
import { scopedTransaction } from "../runs/runs.transaction.js";
import { minorUnitExponent } from "./usage-budget.money.js";

type Reservation = Prisma.UsageReservationGetPayload<object>;
type Projection = Pick<
  TextAttemptState,
  "appliedSequence" | "reservedMinor" | "grossMinor" | "netMinor"
>;
const noPosting: Projection = { appliedSequence: 0, reservedMinor: 0, grossMinor: 0, netMinor: 0 };

function conflict(reason: string): never {
  throw new ConflictException(reason);
}

function terminal(state: TextAttemptState): boolean {
  return state.phase === "NOT_DISPATCHED" || state.phase === "REJECTED";
}

function booked(state: TextAttemptState): boolean {
  return state.phase === "SUCCEEDED" || state.phase === "OWNER_CONFIRMED";
}

async function validateCredits(
  tx: Transaction,
  step: Step,
  run: Run,
  state: TextAttemptState,
): Promise<void> {
  const rows = await tx.usageAdjustment.findMany({
    where: { workspaceId: step.workspaceId, textAttemptId: step.id },
    select: { id: true, channelId: true, currency: true, amountMinor: true, kind: true },
  });
  if (
    rows.length !== Object.keys(state.credits).length ||
    rows.some(
      (row) =>
        row.kind !== "CREDIT" ||
        row.channelId !== run.channelId ||
        row.currency !== state.currency ||
        !Object.hasOwn(state.credits, row.id) ||
        row.amountMinor !== BigInt(state.credits[row.id]!),
    )
  )
    conflict("Linked text credits do not match paid text attempt evidence");
}

function reservationUpdate(
  state: TextAttemptState,
  prior: Reservation,
): Prisma.UsageReservationUpdateManyMutationInput {
  if (booked(state))
    return {
      status: "COMMITTED",
      committedMinor: BigInt(state.netMinor),
      committedAt: prior.committedAt ?? new Date(),
    };
  if (terminal(state)) {
    // Keep a previously committed row and reverse its remaining net, not the original gross.
    if (prior.status === "COMMITTED") return { committedMinor: 0n };
    return {
      status: "RELEASED",
      committedMinor: null,
      releasedAt: prior.releasedAt ?? new Date(),
      releaseReason: state.rejectionCode ?? "NOT_DISPATCHED",
    };
  }
  if (prior.status === "COMMITTED" || prior.status === "RELEASED")
    return conflict("A closed text reservation cannot be reopened");
  return {
    status: "RESERVED",
    expiresAt: new Date("9999-12-31T23:59:59.000Z"),
  };
}

function ledgerError(state: TextAttemptState): string | null {
  switch (state.phase) {
    case "NOT_DISPATCHED":
      return "NOT_DISPATCHED";
    case "REJECTED":
      return state.rejectionCode;
    case "SUCCEEDED":
      return state.usable ? null : "PROVIDER_INVALID_OUTPUT";
    case "OWNER_CONFIRMED":
      return "OWNER_CONFIRMED_TERMINAL_TEXT";
    default:
      return "TEXT_AWAITING_EVIDENCE";
  }
}

async function postLedger(
  tx: Transaction,
  step: Step,
  run: Run,
  state: TextAttemptState,
): Promise<void> {
  if (!state.reservationId) return;
  const reservation = await tx.usageReservation.findFirstOrThrow({
    where: { workspaceId: step.workspaceId, id: state.reservationId },
  });
  if (
    reservation.correlationId !== step.id ||
    reservation.channelId !== run.channelId ||
    reservation.idempotencyKey !== `m08:${state.dispatchKey}` ||
    reservation.currency !== state.currency ||
    reservation.amountMinor !== BigInt(state.estimateMinor)
  )
    conflict("Text arm does not match its usage reservation");
  await tx.usageReservation.updateMany({
    where: { workspaceId: step.workspaceId, id: reservation.id },
    data: reservationUpdate(state, reservation),
  });
  const actualMinor = terminal(state) ? 0 : state.actualMinor;
  const errorCode = ledgerError(state);
  const request = await tx.providerRequest.updateMany({
    where: { workspaceId: step.workspaceId, correlationId: step.id, channelId: run.channelId },
    data: {
      status: errorCode === null ? "SUCCEEDED" : "FAILED",
      errorCode,
      errorMessage: terminal(state) ? errorCode : null,
      actualCost:
        actualMinor === null
          ? null
          : new Prisma.Decimal(actualMinor).div(
              new Prisma.Decimal(10).pow(minorUnitExponent(state.currency)),
            ),
      usage: state.usage ? json(state.usage) : Prisma.DbNull,
      responseMetadata: json({
        dispatchKey: state.dispatchKey,
        providerJobId: state.googleId,
        costKnown: actualMinor !== null,
        costBasis: actualMinor === null ? "RESERVATION" : "BILLED",
        dispatched: state.positiveSent,
        grossMinor: state.grossMinor,
        netMinor: state.netMinor,
      }),
    },
  });
  if (request.count !== 1) conflict("Text arm does not match a provider request");
}

async function postStep(tx: Transaction, step: Step, state: TextAttemptState): Promise<void> {
  const where = { workspaceId: step.workspaceId, id: step.id };
  if (state.phase === "PREPARED") return;
  if (state.phase === "SUCCEEDED" && state.usable) {
    // Once promoted the output may be an archived planning/caption receipt. Keep it and
    // the run's terminal state untouched; later receipt enrichment comes from the evidence.
    await tx.videoRunStep.updateMany({
      where,
      data:
        step.state === "SUCCEEDED"
          ? { costMinor: state.netMinor }
          : {
              state: "WAITING_EXTERNAL",
              output: json({
                output: state.output,
                providerJobId: state.googleId,
                dispatchKey: state.dispatchKey,
                usage: state.usage ?? {},
              }),
              costMinor: state.netMinor,
              providerJobId: state.googleId,
              error: Prisma.DbNull,
              finishedAt: null,
            },
    });
  } else if (booked(state) || terminal(state)) {
    const code = ledgerError(state);
    await tx.videoRunStep.updateMany({
      where,
      data: {
        state: state.phase === "NOT_DISPATCHED" ? "CANCELLED" : "FAILED",
        ...(state.phase === "NOT_DISPATCHED" && { output: { closedBy: "NOT_DISPATCHED" } }),
        costMinor: state.netMinor,
        providerJobId: state.googleId,
        error: { code },
        finishedAt: step.finishedAt ?? new Date(),
      },
    });
  } else await tx.videoRunStep.updateMany({ where, data: { costMinor: state.reservedMinor } });
}

async function postEnvelope(
  tx: Transaction,
  run: Run,
  previous: Projection,
  next: Projection,
): Promise<void> {
  const reserved = next.reservedMinor - previous.reservedMinor;
  const net = next.netMinor - previous.netMinor;
  if (reserved === 0 && net === 0) return;
  const updated = await tx.budgetEnvelope.updateMany({
    where: {
      workspaceId: run.workspaceId,
      runId: run.id,
      ...(reserved < 0 && { reservedMinor: { gte: -reserved } }),
      ...(net < 0 && { spentMinor: { gte: -net } }),
    },
    data: {
      reservedMinor: { increment: reserved },
      spentMinor: { increment: net },
      revision: { increment: 1 },
    },
  });
  // Initial scripting precedes envelope creation. Its step net is used by RunPlanning
  // to initialize the envelope; only a present-but-inconsistent envelope is corruption.
  if (
    updated.count === 0 &&
    (await tx.budgetEnvelope.findFirst({
      where: { workspaceId: run.workspaceId, runId: run.id },
      select: { id: true },
    }))
  )
    conflict("Text posting would underflow the run envelope");
}

function activeStageFailure(run: Run, step: Step, next: TextAttemptState): string | null {
  if (next.preparedStage && next.preparedStage !== run.state) return null;
  const ownsStage = step.key.startsWith("media:text:critic:")
    ? run.state === "CRITIC"
    : ["PLANNING", "SCRIPTING", "SHOT_PLANNING"].includes(run.state);
  if (!ownsStage) return null;
  if (
    next.phase === "REJECTED" ||
    next.phase === "OWNER_CONFIRMED" ||
    (next.phase === "SUCCEEDED" && !next.usable)
  )
    return ledgerError(next);
  return null;
}

async function closeFailedStage(tx: Transaction, run: Run, code: string): Promise<void> {
  await tx.videoRunStep.updateMany({
    where: {
      workspaceId: run.workspaceId,
      runId: run.id,
      key: { in: run.state === "CRITIC" ? [run.state] : [run.state, PLANNING_MANIFEST_KEY] },
      state: "RUNNING",
    },
    data: {
      state: "FAILED",
      finishedAt: new Date(),
      error: { code: code, message: code },
    },
  });
}

async function postEvent(
  tx: Transaction,
  context: Context,
  step: Step,
  run: Run,
  next: TextAttemptState,
  previous: Projection,
): Promise<void> {
  const ownHold = `RECONCILE_REQUIRED: provider submission outcome unknown (${step.id})`;
  const unresolved = next.phase === "ARMED" || next.phase === "SENT";
  const shouldHold =
    unresolved &&
    next.senderRetired &&
    !run.pauseReason &&
    !["FAILED", "CANCELED"].includes(run.state);
  const clearsHold = !unresolved && run.pauseReason === ownHold;
  const stageFailure = activeStageFailure(run, step, next);
  const canChangeReason = !run.pauseReason || clearsHold;
  const db = scopedTransaction(tx, context);
  const otherHold =
    clearsHold || (stageFailure && canChangeReason)
      ? await remainingSubmissionHold(db, tx, run)
      : null;
  const failStage = canChangeReason && !otherHold ? stageFailure : null;
  if (failStage) await closeFailedStage(tx, run, failStage);
  await tx.videoRun.updateMany({
    where: { workspaceId: run.workspaceId, id: run.id },
    data: {
      revision: { increment: 1 },
      ...(shouldHold && { pauseReason: ownHold }),
      ...(clearsHold && { pauseReason: otherHold }),
      ...(failStage && {
        state: "FAILED",
        pauseReason: failStage,
        ...(run.effectiveAutonomy === "L3" && { effectiveAutonomy: "L2" }),
      }),
    },
  });
  await tx.runEvent.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: step.id,
      sequence: run.revision + 1,
      type: failStage ? "step_failed" : shouldHold ? "reconcile_required" : "text_attempt_folded",
      correlationId: run.correlationId,
      payload: {
        dispatchKey: next.dispatchKey,
        phase: next.phase,
        appliedSequence: next.appliedSequence,
        reservedDelta: next.reservedMinor - previous.reservedMinor,
        netDelta: next.netMinor - previous.netMinor,
        ...(shouldHold && { reason: ownHold }),
        ...(failStage && { reason: failStage, from: run.state, to: "FAILED" }),
      },
    },
  });
}

/** Requires the run and attempt lock in tx. No I/O besides accounting writes in this tx. */
export async function foldTextAttempt(
  tx: Transaction,
  context: Context,
  stepId: string,
): Promise<TextAttemptState> {
  const step = await tx.videoRunStep.findFirstOrThrow({
    where: { workspaceId: context.workspaceId, id: stepId, key: { startsWith: "media:text:" } },
  });
  const next = await readTextAttempt(tx, step);
  if (!next) return conflict("Text attempt has no durable evidence");
  const where = { workspaceId: context.workspaceId, attemptId: stepId };
  const previous =
    (await tx.textAttemptProjection.findUnique({
      where: { workspaceId_attemptId: where },
    })) ?? noPosting;
  if (previous.appliedSequence > next.appliedSequence)
    return conflict("Invalid text projection sequence");
  if (previous.appliedSequence === next.appliedSequence) return next;
  const run = await tx.videoRun.findFirstOrThrow({
    where: { workspaceId: context.workspaceId, id: step.runId },
  });
  await validateCredits(tx, step, run, next);
  await postLedger(tx, step, run, next);
  await postEnvelope(tx, run, previous, next);
  await postStep(tx, step, next);
  await postEvent(tx, context, step, run, next, previous);
  const { appliedSequence, reservedMinor, grossMinor, netMinor } = next;
  const data = { appliedSequence, reservedMinor, grossMinor, netMinor };
  await tx.textAttemptProjection.upsert({
    where: { workspaceId_attemptId: where },
    create: { ...where, ...data },
    update: data,
  });
  return next;
}
