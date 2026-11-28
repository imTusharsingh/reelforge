import { isDeepStrictEqual } from "node:util";
import { journalRejections } from "./text-journal-upgrade.js";
import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { isDefinitiveProviderRejection } from "@reelforge/ai-providers";
import type { RunsArtifacts } from "../runs/runs.artifacts.js";
import { proveLocalTextSenderExit, textSenderIdentity } from "./text-sender-identity.js";
import { z } from "zod";
import { StorageObjectNotFoundError } from "../asset/storage/storage.port.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { Context, Json, Step, Transaction } from "../runs/runs.types.js";
import {
  appendTextEvidence,
  lockTextAttempt,
  readTextAttempt,
  type TextAttemptState,
} from "./text-attempt-store.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { maybeCompleteTextCancellation } from "./text-attempt-cancel.js";

const observationSchema = z.object({
  kind: z.enum(["NOT_DISPATCHED", "SENT_EVIDENCE", "REJECTED", "SUCCEEDED", "SENDER_RETIRED"]),
  data: z.record(z.string(), z.json()),
});
export type TextObservation = { kind: z.infer<typeof observationSchema.shape.kind>; data: Json };
const kinds = observationSchema.shape.kind.options;
const logger = new Logger("TextAttemptRecovery");

export async function deliverTextObservation(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
  observation: TextObservation,
): Promise<boolean> {
  try {
    await ingest(access, context, step, nonce, observation);
  } catch (error) {
    if (invalidObservation(error) || error instanceof NotFoundException) throw error;
    await spoolTextObservation(access, context, step, nonce, observation);
    return false;
  }
  await apply(access, context, step).catch(() => undefined);
  return true;
}

export function spoolTextObservation(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
  observation: TextObservation,
): Promise<void> {
  return access.artifacts.writeTextSpool(
    context,
    spoolKey(step.id, nonce, observation.kind),
    Buffer.from(JSON.stringify(observation)),
  );
}

async function ingest(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
  { kind, data }: TextObservation,
): Promise<void> {
  await access.runs.store.db.$transaction(async (tx) => {
    const current = await lockTextAttempt(tx, context.workspaceId, step.id);
    if (current.idempotencyKey !== step.idempotencyKey)
      throw new ConflictException("Text observation does not match its dispatch key");
    const state = await readTextAttempt(tx, current);
    if (kind === "NOT_DISPATCHED") return appendSurrender(tx, current, state, nonce, data);
    if (state?.armNonce !== nonce)
      throw new ConflictException("Text observation does not match its arm");
    if (kind === "REJECTED") {
      const detail = z.object({ httpStatus: z.int(), code: z.string() }).parse(data);
      if (!isDefinitiveProviderRejection(detail.httpStatus, detail.code))
        throw new ConflictException("Response does not prove definitive rejection");
    }
    if (kind === "SENDER_RETIRED") {
      const { after } = z
        .object({ after: z.enum(["SUCCEEDED", "REJECTED"]).optional() })
        .parse(data);
      if (
        after &&
        !(await tx.textAttemptEvidence.findFirst({
          where: {
            workspaceId: context.workspaceId,
            attemptId: step.id,
            eventKey: observationKey(nonce, after),
          },
        }))
      )
        throw new Error("Terminal delivery pending");
    }
    await appendTextEvidence(tx, current, {
      kind,
      nonce,
      data,
      eventKey: observationKey(nonce, kind),
    });
  });
}

async function appendSurrender(
  tx: Transaction,
  step: Step,
  state: TextAttemptState | null,
  nonce: string,
  data: Json,
): Promise<void> {
  const surrender = z
    .object({
      dispatchKey: z.literal(step.idempotencyKey),
      source: z.literal("sender"),
      senderNonce: z.uuid(),
    })
    .parse(data);
  if (!state || (nonce !== "prepared" && surrender.senderNonce !== nonce))
    throw new ConflictException("Invalid text surrender");
  if (state.armNonce && (state.armNonce !== nonce || state.armNonce !== surrender.senderNonce))
    return; // An unacknowledged or duplicate invocation cannot surrender someone else's arm.
  if (state.phase === "NOT_DISPATCHED") return;
  await appendTextEvidence(tx, step, {
    kind: "NOT_DISPATCHED",
    ...(state.armNonce && { nonce }),
    eventKey: state.armNonce ? observationKey(nonce, "NOT_DISPATCHED") : "close-prepared",
    data,
  });
}

async function apply(access: MediaAccess, context: Context, step: Step): Promise<void> {
  await access.runs.store.db.$transaction(async (tx) => {
    await lockTextAttempt(tx, context.workspaceId, step.id);
    await foldTextAttempt(tx, context, step.id);
  });
  await maybeCompleteTextCancellation(access.runs, context, step.runId);
}

export async function recoverTextEvidence(access: MediaAccess, context: Context): Promise<void> {
  if (process.env.PAID_TEXT_V3_ENABLED !== "1") return;
  await closeOrphanPreparations(access, context);
  let cursor: string | undefined;
  for (;;) {
    const arms = await access.runs.store.db.textAttemptEvidence.findMany({
      where: { workspaceId: context.workspaceId, kind: "ARMED" },
      include: { attempt: true },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    if (!arms.length) return;
    for (const arm of arms) {
      if (!arm.nonce) continue;
      try {
        if (!arm.nonce.startsWith("legacy:"))
          await importArmSpool(access, context, arm.attempt, arm.nonce).catch((error: unknown) =>
            reportSweepFailure(arm.attemptId, error),
          );
        await apply(access, context, arm.attempt);
      } catch (error) {
        reportSweepFailure(arm.attemptId, error);
      }
    }
    cursor = arms.at(-1)!.id;
  }
}

async function closeOrphanPreparations(access: MediaAccess, context: Context): Promise<void> {
  const db = access.runs.store.db;
  const pending = await db.videoRunStep.findMany({
    where: {
      workspaceId: context.workspaceId,
      key: { startsWith: "media:text:" },
      state: "RUNNING",
      textEvidence: {
        some: { kind: "PREPARED" },
        none: { kind: "ARMED" },
      },
    },
  });
  for (const attempt of pending) {
    const { id } = attempt;
    await importArmSpool(access, context, attempt, "prepared", ["NOT_DISPATCHED"]).catch(
      (error: unknown) => reportSweepFailure(id, error),
    );
    await db
      .$transaction(async (tx) => {
        const step = await lockTextAttempt(tx, context.workspaceId, id);
        const current = await readTextAttempt(tx, step);
        if (current?.phase === "NOT_DISPATCHED") {
          await foldTextAttempt(tx, context, step.id);
          return;
        }
        if (current?.phase !== "PREPARED") return;
        if (!(await preparationIsOrphaned(tx, step))) return;
        await appendTextEvidence(tx, step, {
          kind: "NOT_DISPATCHED",
          eventKey: "recovery-close-prepared",
          data: { dispatchKey: step.idempotencyKey, source: "reconciler" },
        });
        await foldTextAttempt(tx, context, step.id);
      })
      .catch((error: unknown) => reportSweepFailure(id, error));
  }
}

async function preparationIsOrphaned(tx: Transaction, step: Step): Promise<boolean> {
  const prepared = await tx.textAttemptEvidence.findFirstOrThrow({
    where: { workspaceId: step.workspaceId, attemptId: step.id, kind: "PREPARED" },
  });
  const { expectedRevision, sender } = z
    .object({
      expectedRevision: z.int(),
      sender: textSenderIdentity.optional(),
    })
    .parse(prepared.data);
  const run = await tx.videoRun.findUniqueOrThrow({ where: { id: step.runId } });
  if (run.revision === expectedRevision) {
    if (!sender) return false;
    try {
      proveLocalTextSenderExit(sender);
    } catch {
      return false;
    }
  }
  return true;
}

async function importArmSpool(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
  probe: readonly TextObservation["kind"][] = kinds,
): Promise<void> {
  const db = access.runs.store.db;
  const rows = await db.textAttemptEvidence.findMany({
    where: { workspaceId: context.workspaceId, attemptId: step.id },
    orderBy: { sequence: "asc" },
  });
  const { repaired } = journalRejections(step.idempotencyKey, rows);
  for (const kind of probe) {
    const recorded = rows.find(
      (row) => row.nonce === nonce && row.eventKey === observationKey(nonce, kind),
    );
    if (recorded && !repaired.has(recorded.sequence)) continue;
    const key = spoolKey(step.id, nonce, kind);
    const bytes = await access.artifacts.readTextSpool(context, key).catch((error: unknown) => {
      if (error instanceof StorageObjectNotFoundError) return null;
      throw error;
    });
    if (!bytes) continue;
    if (recorded) {
      // A replacement file at this key may carry different evidence. Keep its owner veto.
      const file = observationSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (
        file.success &&
        file.data.kind === kind &&
        isDeepStrictEqual(file.data.data, recorded.data)
      )
        await access.artifacts.quarantineTextSpool(context, key, bytes);
      continue;
    }
    try {
      const observation = observationSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (observation.kind !== kind)
        throw new ConflictException("Text spool has a mismatched kind");
      await ingest(access, context, step, nonce, observation);
      // Leave the deterministic object intact until the journal is durably applied.
    } catch (error) {
      if (!invalidObservation(error)) throw error;
      await access.artifacts.quarantineTextSpool(context, key, bytes);
      logger.warn(`Quarantined invalid ${kind} evidence for attempt ${step.id}`);
    }
  }
}

const observationKey = (nonce: string, kind: TextObservation["kind"]): string =>
  `observation:${nonce}:${kind}`;
const spoolKey = (stepId: string, nonce: string, kind: TextObservation["kind"]): string =>
  `runs/text-evidence/${stepId}/${nonce}/${kind}.json`;

export async function hasPendingTextOutcome(
  artifacts: RunsArtifacts,
  context: Context,
  step: Step,
  nonce: string,
): Promise<boolean> {
  if (nonce.startsWith("legacy:")) return false;
  for (const kind of ["SUCCEEDED", "REJECTED"] as const) {
    try {
      await artifacts.readTextSpool(context, spoolKey(step.id, nonce, kind));
      return true;
    } catch (error) {
      if (!(error instanceof StorageObjectNotFoundError)) throw error;
    }
  }
  return false;
}

function invalidObservation(error: unknown): boolean {
  return (
    error instanceof ConflictException ||
    error instanceof z.ZodError ||
    error instanceof SyntaxError
  );
}
function reportSweepFailure(attemptId: string, error: unknown): void {
  if (!(error instanceof NotFoundException))
    logger.warn(`Text evidence recovery deferred for attempt ${attemptId}`);
}
