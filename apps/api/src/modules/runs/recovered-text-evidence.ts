import { ConflictException, ForbiddenException } from "@nestjs/common";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  appendTextEvidence,
  lockTextAttempt,
  readTextAttempt,
} from "../usage-budget/text-attempt-store.js";
import { foldTextAttempt } from "../usage-budget/text-attempt-fold.js";
import { remoteTextId } from "../usage-budget/text-evidence.js";
import type { RunsService } from "./runs.service.js";
import { json, type Context, type Step, type Transaction } from "./runs.types.js";

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
const storedOwnerEvidence = z.object({
  source: z.literal("owner_reported"),
  googleId: interactionId,
  usage: usageCounters.optional(),
});
export const RecoveredTextEvidenceSchema = z
  .object({
    dispatchKey: z.string().trim().min(1).max(300),
    providerJobId: interactionId,
    usage: usage.optional(),
    confirmedOriginalAttempt: z.literal(true),
  })
  .strict();

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
  if (process.env.PAID_TEXT_V3_ENABLED !== "1")
    throw new ConflictException("Paid text reconciliation is disabled");
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
  const current = await lockTextAttempt(tx, context.workspaceId, step.id);
  const journal = await readTextAttempt(tx, current);
  if (!journal?.armNonce || journal.phase === "NOT_DISPATCHED")
    throw new ConflictException("The text attempt has no authorized send");
  if (journal.googleId && journal.googleId !== evidence.providerJobId)
    throw new ConflictException("Conflicting Google interaction IDs");
  const earlier = await tx.textAttemptEvidence.findMany({
    where: { workspaceId: context.workspaceId, attemptId: step.id, kind: "RECOVERED_RECEIPT" },
    select: { data: true },
  });
  let counters: Record<string, number> = {};
  for (const row of earlier) {
    const report = storedOwnerEvidence.safeParse(row.data);
    if (!report.success) continue;
    if (report.data.googleId !== evidence.providerJobId)
      throw new ConflictException("Conflicting owner-reported interaction IDs");
    counters = mergeCounters(counters, report.data.usage ?? {});
  }
  const usage = mergeCounters(counters, evidence.usage ?? {});
  for (const [key, value] of Object.entries(usage))
    if (Object.hasOwn(journal.usage ?? {}, key) && journal.usage![key] !== value)
      throw new ConflictException("Counter conflicts with verified provider evidence");
  const fieldHash = createHash("sha256")
    .update(JSON.stringify([evidence.providerJobId, Object.entries(usage).sort()]))
    .digest("hex");
  await appendTextEvidence(tx, current, {
    kind: "RECOVERED_RECEIPT",
    eventKey: `owner-receipt:${fieldHash}`,
    nonce: journal.armNonce,
    data: json({
      dispatchKey: current.idempotencyKey,
      source: "owner_reported",
      googleId: evidence.providerJobId,
      usage,
    }),
  });
  await foldTextAttempt(tx, context, current.id);
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
