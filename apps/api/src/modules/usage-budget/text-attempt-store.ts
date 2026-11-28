import { isDefinitiveProviderRejection } from "@reelforge/ai-providers";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Json, Step, Transaction } from "../runs/runs.types.js";

export type Evidence = {
  sequence: number;
  kind: string;
  nonce: string | null;
  data: unknown;
  eventKey?: string;
};
const detail = z.object({
  dispatchKey: z.string(),
  code: z.string().optional(),
  httpStatus: z.unknown().optional(),
  source: z.string().optional(),
  actualMinor: z.int().optional().nullable(),
});
function definitiveJournalRejection(event: Evidence): boolean {
  const data = detail.parse(event.data);
  if (data.httpStatus !== undefined && data.code)
    return (
      typeof data.httpStatus === "number" &&
      isDefinitiveProviderRejection(data.httpStatus, data.code)
    );
  return (
    !!event.nonce?.startsWith("legacy:") &&
    !!event.eventKey?.startsWith("legacy:REJECTED:") &&
    data.source === "matched-provider" &&
    ["PROVIDER_UNAUTHENTICATED", "PROVIDER_PERMISSION_DENIED"].includes(data.code ?? "")
  );
}

export type TextEvidenceKind =
  | "PREPARED"
  | "ARMED"
  | "SENT_EVIDENCE"
  | "SENDER_RETIRED"
  | "NOT_DISPATCHED"
  | "REJECTED"
  | "SUCCEEDED"
  | "RECOVERED_RECEIPT"
  | "OWNER_CONFIRMED"
  | "QUARANTINED"
  | "CREDIT";

export type TextAttemptPhase =
  | "PREPARED"
  | "ARMED"
  | "SENT"
  | "OWNER_CONFIRMED"
  | "NOT_DISPATCHED"
  | "REJECTED"
  | "SUCCEEDED";

export type TextAttemptState = {
  appliedSequence: number;
  reservedMinor: number;
  grossMinor: number;
  netMinor: number;
  phase: TextAttemptPhase;
  dispatchKey: string;
  modelId: string;
  currency: string;
  estimateMinor: number;
  preparedStage: string | null;
  armNonce: string | null;
  reservationId: string | null;
  positiveSent: boolean;
  senderRetired: boolean;
  ownerConfirmed: boolean;
  googleId: string | null;
  usage: Record<string, Json | null> | null;
  output: Json | null;
  usable: boolean;
  actualMinor: number | null;
  rejectionCode: string | null;
  credits: Readonly<Record<string, number>>;
};

type Append = { kind: TextEvidenceKind; eventKey: string; nonce?: string; data: Json };
const minor = z.int().nonnegative().max(2_147_483_647);
const prepared = z.object({
  dispatchKey: z.string().min(1),
  modelId: z.string().min(1),
  estimateMinor: minor,
  stage: z.string().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
});
const observation = z.object({
  dispatchKey: z.string().min(1),
  googleId: z.string().min(1).nullish(),
  usage: z.record(z.string(), z.json()).nullish(),
  actualMinor: minor.nullish(),
});
const success = observation.extend({ output: z.json().optional(), usable: z.boolean() });
const rejection = observation.extend({ code: z.string().min(1) });
const arm = z.object({ reservationId: z.uuid(), dispatchKey: z.string().optional() });
const credit = z.object({ adjustmentId: z.uuid(), amountMinor: minor.positive() });

function conflicting(): never {
  throw new ConflictException("Contradictory paid text attempt evidence");
}

function initial(dispatchKey: string, event: Evidence): TextAttemptState {
  const { stage, ...data } = prepared.parse(event.data);
  if (
    event.sequence !== 1 ||
    event.kind !== "PREPARED" ||
    event.nonce ||
    data.dispatchKey !== dispatchKey
  )
    return conflicting();
  return {
    ...data,
    preparedStage: stage ?? null,
    appliedSequence: 1,
    reservedMinor: 0,
    grossMinor: 0,
    netMinor: 0,
    phase: "PREPARED",
    armNonce: null,
    reservationId: null,
    positiveSent: false,
    senderRetired: false,
    ownerConfirmed: false,
    googleId: null,
    usage: null,
    output: null,
    usable: false,
    actualMinor: null,
    rejectionCode: null,
    credits: {},
  };
}

function mergeObservation(state: TextAttemptState, data: z.infer<typeof observation>): void {
  if (data.dispatchKey !== state.dispatchKey) conflicting();
  if (data.googleId) {
    if (data.googleId === state.dispatchKey || (state.googleId && state.googleId !== data.googleId))
      conflicting();
    state.googleId = data.googleId;
  }
  if (data.actualMinor != null) {
    if (state.actualMinor != null && state.actualMinor !== data.actualMinor) conflicting();
    state.actualMinor = data.actualMinor;
  }
  if (data.usage) {
    for (const [key, value] of Object.entries(data.usage)) {
      if (Object.hasOwn(state.usage ?? {}, key) && !isDeepStrictEqual(state.usage![key], value))
        conflicting();
    }
    state.usage = { ...state.usage, ...data.usage };
  }
}

function requireSender(state: TextAttemptState, event: Evidence): void {
  if (!state.armNonce || event.nonce !== state.armNonce || state.phase === "NOT_DISPATCHED")
    conflicting();
}

function applyControl(state: TextAttemptState, event: Evidence): boolean {
  const identity = z.object({ dispatchKey: z.literal(state.dispatchKey) });
  switch (event.kind) {
    case "ARMED":
      if (state.phase !== "PREPARED" || !event.nonce) conflicting();
      const data = arm.parse(event.data);
      if (data.dispatchKey && data.dispatchKey !== state.dispatchKey) conflicting();
      state.armNonce = event.nonce;
      state.reservationId = data.reservationId;
      state.phase = "ARMED";
      return true;
    case "NOT_DISPATCHED":
      identity.extend({ source: z.enum(["sender", "reconciler", "legacy"]) }).parse(event.data);
      if ((state.armNonce ?? null) !== event.nonce || state.positiveSent || state.grossMinor)
        conflicting();
      state.phase = "NOT_DISPATCHED";
      state.senderRetired = true;
      return true;
    case "SENT_EVIDENCE":
      requireSender(state, event);
      identity
        .extend({ source: z.enum(["transport", "matched-provider", "legacy"]) })
        .parse(event.data);
      state.positiveSent = true;
      if (state.phase === "ARMED") state.phase = "SENT";
      return true;
    case "SENDER_RETIRED":
      requireSender(state, event);
      identity.parse(event.data);
      state.senderRetired = true;
      return true;
    case "OWNER_CONFIRMED": {
      const data = identity.extend({ source: z.literal("legacy").optional() }).parse(event.data);
      // Historical authorizations survive cutover as audit evidence. They are not
      // proof of send, and can never authorize a new confirmation on that arm.
      const imported =
        data.source === "legacy" &&
        event.eventKey?.startsWith("legacy:OWNER_CONFIRMED:") &&
        event.nonce === state.armNonce &&
        state.phase === "ARMED";
      if (
        !state.senderRetired ||
        state.ownerConfirmed ||
        (!imported && (state.phase !== "SENT" || !state.positiveSent))
      )
        conflicting();
      state.ownerConfirmed = true;
      state.phase = "OWNER_CONFIRMED";
      return true;
    }
    case "CREDIT": {
      const { adjustmentId, amountMinor } = credit.parse(event.data);
      if (Object.hasOwn(state.credits, adjustmentId)) conflicting();
      state.credits = { ...state.credits, [adjustmentId]: amountMinor };
      return true;
    }
    default:
      return false;
  }
}

function applyObservation(state: TextAttemptState, event: Evidence): void {
  requireSender(state, event);
  switch (event.kind) {
    case "QUARANTINED":
      z.object({
        dispatchKey: z.literal(state.dispatchKey),
        kind: z.enum(["RECOVERED_RECEIPT", "REJECTED"]),
        eventKey: z.string(),
        observation: z.object({}),
      }).parse(event.data);
      return;
    case "SUCCEEDED": {
      const result = success.parse(event.data);
      if ((result.usable && result.output == null) || state.phase === "REJECTED") conflicting();
      if (
        state.phase === "SUCCEEDED" &&
        (state.usable !== result.usable || !isDeepStrictEqual(state.output, result.output ?? null))
      )
        conflicting();
      mergeObservation(state, result);
      state.usable = result.usable;
      state.output = result.output ?? null;
      state.phase = "SUCCEEDED";
      break;
    }
    case "REJECTED": {
      const result = rejection.parse(event.data);
      if (
        !definitiveJournalRejection(event) ||
        state.phase === "SUCCEEDED" ||
        (state.actualMinor ?? 0) > 0 ||
        (result.actualMinor ?? 0) > 0 ||
        (state.rejectionCode && state.rejectionCode !== result.code)
      )
        conflicting();
      mergeObservation(state, result);
      state.rejectionCode = result.code;
      state.phase = "REJECTED";
      break;
    }
    case "RECOVERED_RECEIPT": {
      const result = observation.extend({ source: z.string().optional() }).parse(event.data);
      if (result.dispatchKey !== state.dispatchKey) conflicting();
      if (result.source === "owner_reported") return; // Audit only, not matched provider evidence.
      if (state.phase === "REJECTED" && (result.actualMinor ?? 0) > 0) conflicting();
      mergeObservation(state, result);
      if (state.phase === "ARMED") state.phase = "SENT";
      break;
    }
    default:
      return conflicting();
  }
  state.positiveSent = true;
}

export function deriveTextAttempt(
  dispatchKey: string,
  ordered: readonly Evidence[],
): TextAttemptState | null {
  const first = ordered[0];
  if (!first) return null;
  const state = initial(dispatchKey, first);
  for (const event of ordered.slice(1)) {
    if (event.sequence !== state.appliedSequence + 1) conflicting();
    if (!applyControl(state, event)) applyObservation(state, event);
    state.appliedSequence = event.sequence;
    const pending = state.phase === "ARMED" || state.phase === "SENT";
    state.reservedMinor = pending && state.actualMinor === null ? state.estimateMinor : 0;
    state.grossMinor = ["SUCCEEDED", "OWNER_CONFIRMED"].includes(state.phase)
      ? (state.actualMinor ?? state.estimateMinor)
      : pending
        ? (state.actualMinor ?? 0)
        : 0;
    state.netMinor = Math.max(
      0,
      state.grossMinor - Object.values(state.credits).reduce((sum, amount) => sum + amount, 0),
    );
  }
  return state;
}

/** Lock order: run -> attempt. The workspace predicate is part of each lookup. */
export async function lockTextAttempt(
  tx: Transaction,
  workspaceId: string,
  stepId: string,
): Promise<Step> {
  const step = await tx.videoRunStep.findFirst({
    where: { workspaceId, id: stepId, key: { startsWith: "media:text:" } },
    select: { runId: true },
  });
  if (!step) throw new NotFoundException("Paid text attempt not found");
  const run = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM video_runs WHERE workspace_id = ${workspaceId}::uuid AND id = ${step.runId}::uuid FOR UPDATE
  `;
  if (run.length !== 1) throw new NotFoundException("Paid text attempt not found");
  const attempt = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM video_run_steps WHERE workspace_id = ${workspaceId}::uuid AND run_id = ${step.runId}::uuid
      AND id = ${stepId}::uuid FOR UPDATE
  `;
  if (attempt.length !== 1) throw new NotFoundException("Paid text attempt not found");
  return tx.videoRunStep.findFirstOrThrow({
    where: { workspaceId, id: stepId, runId: step.runId },
  });
}

export async function readTextAttempt(
  tx: Transaction,
  step: Step,
): Promise<TextAttemptState | null> {
  return deriveTextAttempt(step.idempotencyKey, await evidenceRows(tx, step));
}

function evidenceRows(tx: Transaction, step: Step): Promise<(Evidence & { eventKey: string })[]> {
  return tx.textAttemptEvidence.findMany({
    where: { workspaceId: step.workspaceId, attemptId: step.id },
    orderBy: { sequence: "asc" },
  });
}

/** Caller must hold the run and attempt locks in the supplied transaction. */
export async function appendTextEvidence(
  tx: Transaction,
  step: Step,
  entry: Append,
): Promise<{ inserted: boolean; sequence: number }> {
  const existing = await evidenceRows(tx, step);
  const nonce = entry.nonce ?? null;
  const original = existing.find((row) => row.eventKey === entry.eventKey);
  if (original) {
    if (
      original.kind !== entry.kind ||
      original.nonce !== nonce ||
      !isDeepStrictEqual(original.data, entry.data)
    )
      conflicting();
    return { inserted: false, sequence: original.sequence };
  }
  const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
  const event = { ...entry, sequence, nonce };
  // Reject corrupt observations before committing to an append-only stream.
  deriveTextAttempt(step.idempotencyKey, [...existing, event]);
  await tx.textAttemptEvidence.create({
    data: { workspaceId: step.workspaceId, attemptId: step.id, ...event },
  });
  return { inserted: true, sequence };
}
