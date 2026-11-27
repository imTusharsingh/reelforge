import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { StorageObjectNotFoundError } from "../asset/storage/storage.port.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { Context, Json, Step } from "../runs/runs.types.js";
import { appendTextEvidence, lockTextAttempt, readTextAttempt } from "./text-attempt-store.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { maybeCompleteTextCancellation } from "./text-attempt-cancel.js";

const observationSchema = z.object({
  kind: z.enum(["SENT_EVIDENCE", "REJECTED", "SUCCEEDED", "SENDER_RETIRED"]),
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
): Promise<void> {
  try {
    await ingest(access, context, step, nonce, observation);
  } catch (error) {
    if (invalidObservation(error) || error instanceof NotFoundException) throw error;
    await access.artifacts.writeTextSpool(
      context,
      spoolKey(step.id, nonce, observation.kind),
      Buffer.from(JSON.stringify(observation)),
    );
    return;
  }
  await apply(access, context, step).catch(() => undefined);
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
    const arm = await tx.textAttemptEvidence.findFirst({
      where: { workspaceId: context.workspaceId, attemptId: step.id, kind: "ARMED", nonce },
    });
    if (!arm || current.idempotencyKey !== step.idempotencyKey)
      throw new ConflictException("Text observation does not match its arm");
    await appendTextEvidence(tx, current, {
      kind,
      nonce,
      data,
      eventKey: observationKey(nonce, kind),
    });
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
        await importArmSpool(access, context, arm.attempt, arm.nonce);
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
        none: { kind: { in: ["ARMED", "NOT_DISPATCHED"] } },
      },
    },
    select: { id: true },
  });
  for (const { id } of pending) {
    await db
      .$transaction(async (tx) => {
        const step = await lockTextAttempt(tx, context.workspaceId, id);
        const current = await readTextAttempt(tx, step);
        if (current?.phase !== "PREPARED") return;
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

async function importArmSpool(
  access: MediaAccess,
  context: Context,
  step: Step,
  nonce: string,
): Promise<void> {
  const db = access.runs.store.db;
  const recorded = new Set(
    (
      await db.textAttemptEvidence.findMany({
        where: { workspaceId: context.workspaceId, attemptId: step.id, nonce },
        select: { eventKey: true },
      })
    ).map((row) => row.eventKey),
  );
  for (const kind of kinds) {
    if (recorded.has(observationKey(nonce, kind))) continue;
    const key = spoolKey(step.id, nonce, kind);
    const bytes = await access.artifacts.readTextSpool(context, key).catch((error: unknown) => {
      if (error instanceof StorageObjectNotFoundError) return null;
      throw error;
    });
    if (!bytes) continue;
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
