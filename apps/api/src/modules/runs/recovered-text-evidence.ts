import { ConflictException, ForbiddenException } from "@nestjs/common";
import { z } from "zod";
import { DISPATCHING, OUTCOME_UNKNOWN } from "../usage-budget/run-admission-state.js";
import { remoteTextId } from "../usage-budget/text-evidence.js";
import type { RunsService } from "./runs.service.js";
import type { Context, Step, Transaction } from "./runs.types.js";

const counterLimit = 32;
const usageCounters = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  z.int().nonnegative(),
);
const usage = usageCounters.refine((values) => Object.keys(values).length <= counterLimit);
const interactionId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,256}$/);
// Read the full existing evidence, even if an older writer let it exceed the limit.
const storedOwnerEvidence = z
  .object({ providerJobId: interactionId, usage: usageCounters.optional() })
  .optional();
export const RecoveredTextEvidenceSchema = z
  .object({
    dispatchKey: z.string().trim().min(1).max(300),
    providerJobId: interactionId,
    usage: usage.optional(),
    confirmedOriginalAttempt: z.literal(true),
  })
  .strict();

const metadataSchema = z.record(z.string(), z.json());
type Evidence = z.infer<typeof RecoveredTextEvidenceSchema>;

/** Record an owner's recovered receipt without treating attestation as verified output or cost. */
export async function attachRecoveredTextEvidence(
  runs: RunsService,
  context: Context,
  runId: string,
  stepId: string,
  evidence: Evidence,
): Promise<void> {
  if (context.role !== "OWNER") throw new ForbiddenException("Workspace owner required");
  const result = await runs.store.mutate(
    context,
    runId,
    "text_evidence_recorded",
    async (db, run, tx) => {
      const step = await db.videoRunStep.findFirst({
        where: { id: stepId, runId: run.id, key: { startsWith: "media:text:" } },
      });
      if (
        !step ||
        step.idempotencyKey !== evidence.dispatchKey ||
        !remoteTextId(step, evidence.providerJobId)
      )
        throw new ConflictException("Evidence does not match the original text attempt");
      await saveEvidence(tx, context, step, evidence);
      return {
        value: null,
        stepId: step.id,
        payload: {
          source: "owner_reported",
          dispatchKey: step.idempotencyKey,
          providerJobId: evidence.providerJobId,
          recordedBy: context.userId,
          ...(evidence.usage && { usage: evidence.usage }),
        },
      };
    },
  );
  await runs.events?.publish(result.event);
}

async function saveEvidence(
  tx: Transaction,
  context: Context,
  step: Step,
  evidence: Evidence,
): Promise<void> {
  const row = await tx.providerRequest.findUnique({
    where: {
      workspaceId_correlationId: { workspaceId: context.workspaceId, correlationId: step.id },
    },
  });
  const metadata = metadataSchema.safeParse(row?.responseMetadata).data;
  if (
    metadata?.dispatched !== true ||
    !row ||
    !(
      row.status === "SUCCEEDED" ||
      row.status === "FAILED" ||
      row.errorCode === DISPATCHING ||
      row.errorCode === OUTCOME_UNKNOWN
    )
  )
    throw new ConflictException("The attempt has no dispatched text call");
  const known =
    remoteTextId(step, step.providerJobId) ??
    remoteTextId(step, typeof metadata.providerJobId === "string" ? metadata.providerJobId : null);
  if (known && known !== evidence.providerJobId)
    throw new ConflictException("Conflicting Google interaction IDs");
  const stored = storedOwnerEvidence.safeParse(metadata.ownerReportedEvidence);
  if (!stored.success)
    throw new ConflictException("Existing owner-reported evidence cannot be merged");
  const reported = stored.data;
  if (reported && reported.providerJobId !== evidence.providerJobId)
    throw new ConflictException("Conflicting owner-reported interaction IDs");
  const counters = mergeCounters(reported?.usage ?? {}, evidence.usage ?? {});
  await tx.providerRequest.update({
    where: { id: row.id },
    data: {
      responseMetadata: {
        ...metadata,
        dispatchKey: step.idempotencyKey,
        ownerReportedEvidence: {
          providerJobId: evidence.providerJobId,
          usage: counters,
          recordedBy: context.userId,
        },
      },
    },
  });
}

function mergeCounters(
  existing: Record<string, number>,
  incoming: Record<string, number>,
): Record<string, number> {
  if (
    Object.entries(incoming).some(
      ([key, value]) => Object.hasOwn(existing, key) && existing[key] !== value,
    )
  )
    throw new ConflictException("Conflicting owner-reported usage counters");
  const merged = usage.safeParse({ ...existing, ...incoming });
  if (!merged.success)
    throw new ConflictException(
      `Owner-reported evidence allows at most ${counterLimit} usage counters`,
    );
  return merged.data;
}
