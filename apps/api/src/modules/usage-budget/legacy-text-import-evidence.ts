import type { Prisma } from "@reelforge/database";
import type { Event, Step } from "../runs/runs.types.js";
import { extractLegacyObservations } from "./legacy-text-import-observations.js";
import { legacyObject } from "./legacy-text-import-fields.js";

export const legacyPrepared = "VIDEO_RUN_TEXT_PREPARED";
export const legacyProtocol = "sync-text-advisory-v2";
const liveMarkers = new Set(["VIDEO_RUN_DISPATCHING", "VIDEO_RUN_OUTCOME_UNKNOWN"]);
const maxMinor = 2_147_483_647n;

export type LegacyTextEvent = {
  kind: string;
  eventKey: string;
  nonce: string | null;
  data: Prisma.InputJsonObject;
};
export type LegacyTextSource = {
  step: Step;
  channelId: string;
  revision: number;
  stage: string;
  request: Prisma.ProviderRequestGetPayload<object> | null;
  reservation: Prisma.UsageReservationGetPayload<object> | null;
  activity: Event[];
  credits: Prisma.UsageAdjustmentGetPayload<object>[];
};
type Balance = { reservedMinor: number; grossMinor: number; netMinor: number };
export type LegacyImportPlan = {
  action: "import" | "release-preparation";
  outcome:
    | "held"
    | "sent"
    | "completed"
    | "pending-completion"
    | "owner-settled"
    | "rejected"
    | "non-dispatched";
  events: LegacyTextEvent[];
  appliedSequence: number;
  before: Balance;
  after: Balance;
  linkedCreditMinor: number;
};
export type LegacyImportResult = LegacyImportPlan | { action: "blocked"; reason: string };

const validMinor = (value: bigint): boolean => value >= 0n && value <= maxMinor;
const block = (reason: string): LegacyImportResult => ({ action: "blocked", reason });

function keyConflict(payload: unknown, dispatchKey: string): boolean {
  const row = legacyObject(payload);
  return [row.dispatchKey, row.idempotencyKey].some(
    (key) => key !== undefined && key !== dispatchKey,
  );
}
function scopedEvents(source: LegacyTextSource): Event[] {
  const { step } = source;
  return source.activity.filter(
    (event) =>
      event.workspaceId === step.workspaceId &&
      event.runId === step.runId &&
      event.stepId === step.id &&
      !keyConflict(event.payload, step.idempotencyKey),
  );
}
function validateRows({
  step,
  channelId,
  request,
  reservation,
  credits,
}: LegacyTextSource): string | undefined {
  if (!request || !reservation) return "missing matching legacy request or reservation";
  if (
    request.workspaceId !== step.workspaceId ||
    request.correlationId !== step.id ||
    request.channelId !== channelId ||
    request.providerId !== "gemini" ||
    reservation.workspaceId !== step.workspaceId ||
    (reservation.correlationId !== null && reservation.correlationId !== step.id) ||
    reservation.channelId !== channelId ||
    reservation.idempotencyKey !== `m08:${step.idempotencyKey}`
  )
    return "legacy request and reservation identities do not match";
  if (
    request.currency !== reservation.currency ||
    reservation.currency !== "USD" ||
    !validMinor(reservation.amountMinor) ||
    !validMinor(reservation.committedMinor ?? 0n) ||
    (reservation.committedMinor !== null && reservation.committedMinor > reservation.amountMinor)
  )
    return "legacy accounting balances or currencies do not match";
  const metadata = legacyObject(request.responseMetadata);
  if (
    keyConflict(metadata, step.idempotencyKey) ||
    (metadata.stepId !== undefined && metadata.stepId !== step.id)
  )
    return "legacy ledger dispatch identity does not match";
  if (
    credits.some(
      (entry) =>
        entry.workspaceId !== step.workspaceId ||
        entry.textAttemptId !== step.id ||
        entry.channelId !== channelId ||
        entry.currency !== reservation.currency ||
        entry.kind !== "CREDIT" ||
        !entry.operationKey ||
        !validMinor(entry.amountMinor) ||
        entry.amountMinor === 0n,
    )
  )
    return "legacy credit does not match original scoped charge";
}
function legacyEvent(
  kind: string,
  sourceId: string,
  data: Prisma.InputJsonObject,
  nonce: string | null = null,
): LegacyTextEvent {
  return { kind, eventKey: `legacy:${kind}:${sourceId}`, nonce, data };
}

function zeroLedger(source: LegacyTextSource): boolean {
  const row = source.request!;
  const metadata = legacyObject(row.responseMetadata);
  return (
    row.status === "FAILED" &&
    row.errorCode === "NOT_DISPATCHED" &&
    row.actualCost?.isZero() === true &&
    row.usage === null &&
    metadata.costKnown === true &&
    metadata.dispatched === false &&
    !metadata.providerJobId &&
    !source.step.providerJobId
  );
}
function releasedBeforePost(source: LegacyTextSource, events: Event[]): Event | undefined {
  if (!zeroLedger(source) || source.step.state !== "CANCELLED") return;
  return events.find(
    (event) =>
      event.type === "dispatch_released" &&
      [
        "NOT_DISPATCHED",
        "Text dispatch claim changed before POST",
        "Text dispatch admission changed before POST",
        "Ownership lost before dispatch",
      ].includes(String(legacyObject(event.payload).reason)),
  );
}
function drainedPreparation(source: LegacyTextSource, events: Event[]): boolean {
  const { step, request, reservation } = source;
  const metadata = legacyObject(request!.responseMetadata);
  return (
    request!.errorCode === legacyPrepared &&
    request!.status === "FAILED" &&
    metadata.textDispatchProtocol === legacyProtocol &&
    metadata.dispatched !== true &&
    request!.actualCost === null &&
    request!.usage === null &&
    ["RESERVED", "EXPIRED"].includes(reservation!.status) &&
    reservation!.committedMinor === null &&
    step.state === "RUNNING" &&
    !step.providerJobId &&
    !metadata.providerJobId &&
    !events.some((event) =>
      [
        "text_dispatch_started",
        "provider_dispatch",
        "reconcile_required",
        "provider_submitted",
        "text_evidence_recorded",
        "step_failed",
        "media_completed",
      ].includes(event.type),
    )
  );
}

function sourceBalance(source: LegacyTextSource, holding: boolean, creditMinor: number): Balance {
  const { reservation } = source;
  const grossMinor =
    reservation!.status === "COMMITTED" ? Number(reservation!.committedMinor ?? 0n) : 0;
  return {
    reservedMinor: holding ? Number(reservation!.amountMinor) : 0,
    grossMinor,
    netMinor: Math.max(0, grossMinor - creditMinor),
  };
}

export function planLegacyTextImport(source: LegacyTextSource): LegacyImportResult {
  const invalid = validateRows(source);
  if (invalid) return block(invalid);
  const { step, request, reservation } = source;
  const dispatchKey = step.idempotencyKey;
  const activity = scopedEvents(source);
  const observed = extractLegacyObservations(source, activity, zeroLedger(source));
  if ("reason" in observed) return block(observed.reason);
  const release = releasedBeforePost(source, activity);
  if (reservation!.correlationId === null && !release)
    return block("detached legacy reservation has no exact pre-POST release");
  const prepared = drainedPreparation(source, activity);
  if ((release || prepared) && (observed.send || observed.outcome || observed.owner))
    return block("legacy dispatch and release evidence conflict");
  const events = [
    legacyEvent("PREPARED", request!.id, {
      dispatchKey,
      modelId: request!.capabilityId,
      estimateMinor: Number(reservation!.amountMinor),
      currency: reservation!.currency,
      input: step.input,
      stage: source.stage,
      expectedRevision: source.revision,
    }),
  ];
  const creditMinor = source.credits.reduce((sum, credit) => sum + Number(credit.amountMinor), 0);
  if (!Number.isSafeInteger(creditMinor)) return block("legacy credit overflow");
  if (release || prepared) return releasePlan(source, events, release, creditMinor);
  const provenArm =
    liveMarkers.has(request!.errorCode ?? "") ||
    observed.send ||
    observed.outcome ||
    observed.owner;
  if (!provenArm || !["RESERVED", "EXPIRED", "RELEASED", "COMMITTED"].includes(reservation!.status))
    return block("no proven legacy disposition");
  return armPlan(source, events, observed, creditMinor);
}

function releasePlan(
  source: LegacyTextSource,
  events: LegacyTextEvent[],
  release: Event | undefined,
  creditMinor: number,
): LegacyImportResult {
  const { step, reservation } = source;
  if (
    creditMinor > 0 ||
    (reservation!.committedMinor && reservation!.committedMinor !== 0n) ||
    (release && !["EXPIRED", "RELEASED"].includes(reservation!.status))
  )
    return block("legacy non-dispatch conflicts with a posting");
  events.push(
    legacyEvent("NOT_DISPATCHED", release?.id ?? reservation!.id, {
      dispatchKey: step.idempotencyKey,
      source: "legacy",
    }),
  );
  return {
    action: release ? "import" : "release-preparation",
    outcome: "non-dispatched",
    events,
    appliedSequence: events.length,
    before: sourceBalance(source, !release && reservation!.status === "RESERVED", 0),
    after: sourceBalance(source, false, 0),
    linkedCreditMinor: 0,
  };
}

function armPlan(
  source: LegacyTextSource,
  events: LegacyTextEvent[],
  observed: Exclude<ReturnType<typeof extractLegacyObservations>, { reason: string }>,
  creditMinor: number,
): LegacyImportResult {
  const { reservation } = source;
  const nonce = `legacy:${reservation!.id}`;
  const { send, outcome, owner } = observed;
  if (
    (reservation!.status === "COMMITTED" && !outcome && !owner) ||
    (reservation!.status === "RELEASED" && !outcome) ||
    (creditMinor > 0 && reservation!.status !== "COMMITTED")
  )
    return block("legacy disposition does not explain existing postings");
  appendArmEvents(source, events, observed, nonce);
  // A known zero already posted on an expired reservation is not an active hold.
  const held =
    reservation!.status === "RESERVED" ||
    (reservation!.status === "EXPIRED" && outcome?.kind !== "REJECTED");
  const needsFold = held && Boolean(outcome);
  const before = sourceBalance(source, held, creditMinor);
  return {
    action: "import",
    outcome: needsFold
      ? "pending-completion"
      : outcome?.kind === "REJECTED"
        ? "rejected"
        : outcome
          ? "completed"
          : owner
            ? "owner-settled"
            : send
              ? "sent"
              : "held",
    events,
    appliedSequence: events.length - Number(needsFold),
    before,
    after: before,
    linkedCreditMinor: creditMinor,
  };
}

function appendArmEvents(
  source: LegacyTextSource,
  events: LegacyTextEvent[],
  observed: Exclude<ReturnType<typeof extractLegacyObservations>, { reason: string }>,
  nonce: string,
): void {
  const { step, reservation } = source;
  const dispatchKey = step.idempotencyKey;
  const { send, outcome, owner, recovered } = observed;
  events.push(
    legacyEvent(
      "ARMED",
      reservation!.id,
      {
        dispatchKey,
        reservationId: reservation!.id,
        incarnation: "drained-legacy-writer",
      },
      nonce,
    ),
  );
  if (send)
    events.push(legacyEvent("SENT_EVIDENCE", send, { dispatchKey, source: "legacy" }, nonce));
  events.push(legacyEvent("SENDER_RETIRED", reservation!.id, { dispatchKey }, nonce));
  for (const receipt of recovered)
    events.push(legacyEvent("RECOVERED_RECEIPT", receipt.id, receipt.data, nonce));
  if (owner)
    events.push(
      legacyEvent(
        "OWNER_CONFIRMED",
        owner.id,
        {
          dispatchKey,
          confirmedBy: owner.confirmedBy,
          source: "legacy",
        },
        nonce,
      ),
    );
  if (outcome) events.push(legacyEvent(outcome.kind, outcome.id, outcome.data, nonce));
  for (const credit of source.credits)
    events.push(
      legacyEvent("CREDIT", credit.id, {
        adjustmentId: credit.id,
        amountMinor: Number(credit.amountMinor),
      }),
    );
}
