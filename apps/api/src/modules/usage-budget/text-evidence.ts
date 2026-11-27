import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import {
  json,
  type Context,
  type Json,
  type Run,
  type Scoped,
  type Step,
  type Transaction,
} from "../runs/runs.types.js";
import { clearResolvedSubmissionHold } from "../runs/run-outcomes.js";
import { attachedTextResult } from "./run-admission-state.js";

const fields = z.record(z.string(), z.json());
const usageField = z.object({ usage: fields });
export function remoteTextId(step: Step, reference: string | null): string | null {
  // Older workers used the local dispatch key in the remote-ID column.
  return reference && reference !== step.idempotencyKey ? reference : null;
}

export function textReceiptReference(
  step: Step,
  observedReference: string,
): { providerJobId: string | null; dispatchKey: string } {
  return {
    providerJobId: remoteTextId(step, observedReference) ?? remoteTextId(step, step.providerJobId),
    dispatchKey: step.idempotencyKey,
  };
}

export async function recordTextEvidence(
  tx: Transaction,
  context: Context,
  step: Step,
  reference: string | null,
  usage?: Record<string, unknown>,
): Promise<string | null> {
  const where = { workspaceId: context.workspaceId, correlationId: step.id };
  const row = await tx.providerRequest.findUniqueOrThrow({
    where: { workspaceId_correlationId: where },
  });
  const metadata = fields.safeParse(row.responseMetadata).data ?? {};
  const prior =
    remoteTextId(step, step.providerJobId) ??
    remoteTextId(step, typeof metadata.providerJobId === "string" ? metadata.providerJobId : null);
  const incoming = remoteTextId(step, reference);
  if (prior && incoming && prior !== incoming)
    throw new ConflictException("Conflicting Google interaction IDs");
  const id = incoming ?? prior;
  delete metadata.providerJobId;
  await tx.providerRequest.update({
    where: { id: row.id },
    data: {
      responseMetadata: json({
        ...metadata,
        dispatchKey: step.idempotencyKey,
        ...(id && { providerJobId: id }),
      }),
      ...(usage && { usage: json({ ...fields.safeParse(row.usage).data, ...usage }) }),
    },
  });
  return id;
}

export async function attachTextEvidence(
  db: Scoped,
  tx: Transaction,
  context: Context,
  run: Run,
  claim: Step,
  reference: string,
  output?: Json,
): Promise<{
  value: Step;
  payload: { dispatchKey: string; providerJobId: string | null };
  stepId: string;
  eventType: string;
}> {
  const current = await db.videoRunStep.findFirstOrThrow({
    where: { id: claim.id, runId: run.id },
  });
  if (
    current.idempotencyKey !== claim.idempotencyKey ||
    !["RUNNING", "WAITING_EXTERNAL", "SUCCEEDED", "FAILED"].includes(current.state)
  )
    throw new ConflictException("Text dispatch claim changed");
  const providerJobId = await recordTextEvidence(
    tx,
    context,
    current,
    reference,
    usageField.safeParse(output).data?.usage,
  );
  const closed = current.state === "FAILED" || current.state === "SUCCEEDED";
  await db.videoRunStep.updateMany({
    where: { id: current.id },
    data: {
      providerJobId,
      ...(!closed && {
        state: "WAITING_EXTERNAL",
        ...(output !== undefined && !attachedTextResult(current) && { output }),
      }),
    },
  });
  const value = await db.videoRunStep.findFirstOrThrow({ where: { id: current.id } });
  if (!closed) await clearResolvedSubmissionHold(db, tx, run, current.id);
  return {
    value,
    payload: { providerJobId, dispatchKey: claim.idempotencyKey },
    stepId: claim.id,
    eventType: closed ? "text_evidence_recorded" : "provider_submitted",
  };
}

export async function retainedOwnerEvidence(
  tx: Transaction,
  context: Context,
  step: Step,
): Promise<{ ownerReportedEvidence?: z.infer<typeof fields>[string] }> {
  if (!step.key.startsWith("media:text:")) return {};
  const row = await tx.providerRequest.findUnique({
    where: {
      workspaceId_correlationId: { workspaceId: context.workspaceId, correlationId: step.id },
    },
    select: { responseMetadata: true },
  });
  const ownerReportedEvidence = fields.safeParse(row?.responseMetadata).data?.ownerReportedEvidence;
  return ownerReportedEvidence === undefined ? {} : { ownerReportedEvidence };
}
