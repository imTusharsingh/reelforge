import { reconcileExisting } from "./legacy-journal-reconcile.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { operatorContext } from "./text-attempt-ops.js";
import { linkMediaCredit, provenMediaLinks } from "./legacy-media-credit.js";
import { z } from "zod";
import type { Database, Run, Step, Transaction } from "../runs/runs.types.js";
import {
  auditedLegacyCredits,
  unresolvedLegacyCredits,
  type LegacyCredits,
} from "./legacy-text-import-credits.js";
import { type LegacyImportPlan, planLegacyTextImport } from "./legacy-text-import-evidence.js";
import { legacyObject } from "./legacy-text-import-fields.js";
import { deriveTextAttempt, lockTextAttempt } from "./text-attempt-store.js";

const scope = z.uuid();
const audit = z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/u);
export type LegacyTextImportOptions = {
  workspaceId: string;
  apply?: boolean;
  oldWritersDrained?: boolean;
  auditId?: string;
};
export type Imported = {
  attemptId: string;
  action:
    | LegacyImportPlan["action"]
    | "blocked"
    | "already-imported"
    | "requires-reconciliation"
    | "reconciled";
  creditIds?: string[];
  reason?: string;
  outcome?: LegacyImportPlan["outcome"];
  before?: LegacyImportPlan["before"];
  after?: LegacyImportPlan["after"];
};
type Reservation = NonNullable<Parameters<typeof planLegacyTextImport>[0]["reservation"]>;
type Ledger = NonNullable<Parameters<typeof planLegacyTextImport>[0]["request"]>;

type ImportReport = {
  mode: "dry-run" | "apply";
  workspaceId: string;
  attempts: Imported[];
  unresolvedCreditIds: string[];
  mediaCreditLinks: Awaited<ReturnType<typeof provenMediaLinks>>;
};

export async function importLegacyTextAttempts(
  db: Database,
  options: LegacyTextImportOptions,
): Promise<ImportReport> {
  const workspaceId = scope.parse(options.workspaceId);
  if (options.apply && process.env.PAID_TEXT_V3_ENABLED === "1")
    throw new Error("Disable new paid text dispatch before applying the legacy import.");
  if (options.apply && (!options.oldWritersDrained || !audit.safeParse(options.auditId).success))
    throw new Error(
      "Apply requires an audit ID and explicit confirmation that all old writers were drained.",
    );
  return db.$transaction((tx) => cutover(tx, workspaceId, options), {
    timeout: 120_000,
    isolationLevel: options.apply ? "ReadCommitted" : "RepeatableRead",
  });
}

async function lockCutover(tx: Transaction, workspaceId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM video_runs WHERE workspace_id = ${workspaceId}::uuid ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT id FROM usage_budgets WHERE workspace_id = ${workspaceId}::uuid ORDER BY id FOR UPDATE`;
}

async function cutover(
  tx: Transaction,
  workspaceId: string,
  options: LegacyTextImportOptions,
): Promise<ImportReport> {
  if (options.apply) await lockCutover(tx, workspaceId);
  const attempts: Imported[] = [];
  const candidates = await unresolvedLegacyCredits(tx, workspaceId, true);
  const media = await provenMediaLinks(tx, workspaceId, candidates);
  const provenIds = new Set(media.map((link) => link.adjustmentId));
  const blocked = candidates.some((id) => !provenIds.has(id));
  if (options.apply && !blocked)
    for (const link of media) await linkMediaCredit(tx, workspaceId, link, options.auditId!);
  let cursor: string | undefined;
  while (!blocked) {
    const batch = await tx.videoRunStep.findMany({
      where: {
        workspaceId,
        key: { startsWith: "media:text:" },
        ...(cursor && { id: { gt: cursor } }),
      },
      orderBy: { id: "asc" },
      select: { id: true },
      take: 100,
    });
    if (!batch.length) break;
    for (const { id } of batch) attempts.push(await importOne(tx, id, options));
    cursor = batch.at(-1)!.id;
  }
  // Every proven adjustment link is now visible to the ordinary reversal guard.
  if (options.apply)
    for (const report of attempts)
      if (report.action === "reconciled")
        await foldTextAttempt(tx, operatorContext(workspaceId), report.attemptId);
  return {
    mode: options.apply ? "apply" : "dry-run",
    workspaceId,
    attempts,
    unresolvedCreditIds: await unresolvedLegacyCredits(tx, workspaceId, false),
    mediaCreditLinks: media,
  };
}

async function importOne(
  tx: Transaction,
  id: string,
  options: LegacyTextImportOptions,
): Promise<Imported> {
  const { workspaceId } = options;
  const step = options.apply
    ? await lockTextAttempt(tx, workspaceId, id)
    : await tx.videoRunStep.findFirstOrThrow({ where: { workspaceId, id } });
  const run = await tx.videoRun.findFirstOrThrow({ where: { workspaceId, id: step.runId } });
  const existing = await reconcileExisting(tx, run, step, options);
  if (existing) return existing;
  const { request, reservation, activity, credits } = await readSources(tx, step, run);
  if (!credits)
    return { attemptId: id, action: "blocked", reason: "conflicting legacy credit audit" };
  const plan = planLegacyTextImport({
    step,
    channelId: run.channelId,
    revision: run.revision,
    stage: run.state,
    request,
    reservation,
    activity,
    credits: credits.rows,
  });
  if (plan.action === "blocked") return { attemptId: id, ...plan };
  const events = importRows(plan);
  if (!matchesBalances(step, plan, events))
    return {
      attemptId: id,
      action: "blocked",
      reason: "legacy posting does not match its evidence",
    };
  if (options.apply)
    await writeImport(tx, run, step, plan, {
      request: request!,
      reservation: reservation!,
      credits,
      events,
      auditId: options.auditId!,
    });
  return {
    attemptId: id,
    action: plan.action,
    outcome: plan.outcome,
    before: plan.before,
    after: plan.after,
  };
}

async function readSources(
  tx: Transaction,
  step: Step,
  run: Run,
): Promise<{
  request: Ledger | null;
  reservation: Reservation | null;
  activity: Parameters<typeof planLegacyTextImport>[0]["activity"];
  credits: LegacyCredits | null;
}> {
  const { workspaceId, id, idempotencyKey } = step;
  const request = await tx.providerRequest.findUnique({
    where: { workspaceId_correlationId: { workspaceId, correlationId: id } },
  });
  const reservation = await tx.usageReservation.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: `m08:${idempotencyKey}` } },
  });
  const activity = await tx.runEvent.findMany({
    where: { workspaceId, runId: run.id, stepId: id },
    orderBy: { sequence: "asc" },
  });
  const credits = await auditedLegacyCredits(tx, step, run.channelId);
  return { request, reservation, activity, credits };
}

type Rows = ReturnType<typeof importRows>;
function importRows(
  plan: LegacyImportPlan,
): Array<LegacyImportPlan["events"][number] & { sequence: number }> {
  return plan.events.map((event, index) => ({ ...event, sequence: index + 1 }));
}
function matchesBalances(step: Step, plan: LegacyImportPlan, events: Rows): boolean {
  try {
    deriveTextAttempt(step.idempotencyKey, events);
    const state = deriveTextAttempt(step.idempotencyKey, events.slice(0, plan.appliedSequence));
    return (
      state?.reservedMinor === plan.after.reservedMinor &&
      state.grossMinor === plan.after.grossMinor &&
      state.netMinor === plan.after.netMinor
    );
  } catch {
    return false; // Never write contradictory historical events.
  }
}

type WriteSource = {
  request: Ledger;
  reservation: Reservation;
  credits: LegacyCredits;
  auditId: string;
  events: Rows;
};
async function writeImport(
  tx: Transaction,
  run: Run,
  step: Step,
  plan: LegacyImportPlan,
  source: WriteSource,
): Promise<void> {
  const { request, reservation, credits, auditId, events } = source;
  const where = { workspaceId: run.workspaceId, attemptId: step.id };
  if (plan.action === "release-preparation")
    await releasePrepared(tx, run, step, request, reservation);
  else if (plan.outcome === "non-dispatched")
    await tx.videoRunStep.update({
      where: { id: step.id },
      data: { costMinor: 0, output: { ...legacyObject(step.output), closedBy: "NOT_DISPATCHED" } },
    });
  else await seedLegacyPosting(tx, run, step, plan, reservation, credits);
  await tx.textAttemptEvidence.createMany({
    data: events.map((event) => ({ ...where, ...event })),
  });
  await tx.textAttemptProjection.create({
    data: { ...where, ...plan.after, appliedSequence: plan.appliedSequence },
  });
  const ownHold = `RECONCILE_REQUIRED: provider submission outcome unknown (${step.id})`;
  const held = plan.outcome === "held" || plan.outcome === "sent";
  await tx.videoRun.updateMany({
    where: { workspaceId: run.workspaceId, id: run.id },
    data: {
      revision: { increment: 1 },
      ...(!run.pauseReason &&
        held &&
        !["FAILED", "CANCELED"].includes(run.state) && { pauseReason: ownHold }),
      ...(plan.outcome === "non-dispatched" &&
        run.pauseReason === ownHold && { pauseReason: null }),
    },
  });
  await tx.runEvent.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      stepId: step.id,
      sequence: run.revision + 1,
      type: "legacy_text_imported",
      correlationId: run.correlationId,
      payload: {
        auditId,
        outcome: plan.outcome,
        requestId: request.id,
        reservationId: reservation.id,
        before: plan.before,
        after: plan.after,
        originalReservationStatus: reservation.status,
        originalExpiresAt: reservation.expiresAt.toISOString(),
        eventKeys: events.map((event) => event.eventKey),
      },
    },
  });
}

async function seedLegacyPosting(
  tx: Transaction,
  run: Run,
  step: Step,
  plan: LegacyImportPlan,
  reservation: Reservation,
  credits: LegacyCredits,
): Promise<void> {
  if (plan.after.reservedMinor > 0)
    await tx.usageReservation.update({
      where: { id: reservation.id },
      data: { status: "RESERVED", expiresAt: new Date("9999-12-31T23:59:59Z") },
    });
  for (const { adjustmentId, operationKey } of credits.links)
    await tx.usageAdjustment.update({
      where: { id: adjustmentId },
      data: { textAttemptId: step.id, operationKey },
    });
  if (plan.linkedCreditMinor === 0 || reservation.status !== "COMMITTED") return;
  const reduction = plan.after.grossMinor - plan.after.netMinor;
  if (!reduction) return;
  await tx.usageReservation.update({
    where: { id: reservation.id },
    data: { committedMinor: BigInt(plan.after.netMinor) },
  });
  await tx.videoRunStep.update({
    where: { id: step.id },
    data: { costMinor: plan.after.netMinor },
  });
  await decrementEnvelope(tx, run, "spentMinor", reduction);
}

async function releasePrepared(
  tx: Transaction,
  run: Run,
  step: Step,
  request: Ledger,
  reservation: Reservation,
): Promise<void> {
  const { workspaceId } = step;
  const amount = Number(reservation.amountMinor);
  if (step.costMinor !== amount) throw new Error("Prepared legacy reservation amount changed.");
  await decrementEnvelope(tx, run, "reservedMinor", amount);
  await tx.usageReservation.update({
    where: { id: reservation.id },
    data: {
      status: "RELEASED",
      releasedAt: new Date(),
      releaseReason: "LEGACY_PREPARATION_DRAINED",
    },
  });
  await tx.providerRequest.update({
    where: { id: request.id },
    data: {
      errorCode: "NOT_DISPATCHED",
      actualCost: 0,
      responseMetadata: {
        dispatchKey: step.idempotencyKey,
        stepId: step.id,
        dispatched: false,
        costKnown: true,
      },
    },
  });
  await tx.videoRunStep.updateMany({
    where: { workspaceId, id: step.id },
    data: {
      state: "CANCELLED",
      output: { closedBy: "NOT_DISPATCHED" },
      costMinor: 0,
      finishedAt: new Date(),
    },
  });
}

async function decrementEnvelope(
  tx: Transaction,
  run: Run,
  field: "reservedMinor" | "spentMinor",
  amount: number,
): Promise<void> {
  if (amount === 0) return;
  const where = { workspaceId: run.workspaceId, runId: run.id };
  const envelope = await tx.budgetEnvelope.findFirst({ where });
  if (!envelope) return; // Planning can precede envelope creation.
  if (envelope[field] < amount)
    throw new Error("Legacy adjustment would underflow the run envelope.");
  await tx.budgetEnvelope.updateMany({
    where,
    data: { [field]: { decrement: amount }, revision: { increment: 1 } },
  });
}
