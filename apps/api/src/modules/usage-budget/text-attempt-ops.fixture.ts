import { randomUUID } from "node:crypto";
import type { Tenant } from "../runs/runs.fixture.js";
import { json, type Step } from "../runs/runs.types.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { drainedLegacyIncarnation, type TextAttemptOpsTarget } from "./text-attempt-ops-schema.js";
import { appendTextEvidence, lockTextAttempt } from "./text-attempt-store.js";
import { currentTextSenderIdentity, type TextSenderIdentity } from "./text-sender-identity.js";

type ArmAudit = {
  target: TextAttemptOpsTarget;
  actor: string;
  observedAt: string;
  reference: string;
  source: string;
};
type ArmFixture = {
  step: Step;
  target: TextAttemptOpsTarget;
  sender: TextSenderIdentity;
  exit: ArmAudit & { sender: TextSenderIdentity; result: string };
  receipt: ArmAudit & { googleId: string };
  reservationId: string;
};

export async function armFixture(
  t: Tenant,
  legacy = false,
  key = "media:text:scriptwriter",
): Promise<ArmFixture> {
  const workspaceId = t.context.workspaceId;
  const dispatchKey = randomUUID();
  const step = await t.db.videoRunStep.create({
    data: {
      workspaceId,
      runId: t.run.id,
      key,
      idempotencyKey: dispatchKey,
      state: "RUNNING",
      input: {},
    },
  });
  const sender = currentTextSenderIdentity();
  const incarnation = legacy ? drainedLegacyIncarnation : sender.incarnation;
  const { reservationId, armNonce } = await t.db.$transaction(async (tx) => {
    const locked = await lockTextAttempt(tx, workspaceId, step.id);
    await appendTextEvidence(tx, locked, {
      kind: "PREPARED",
      eventKey: "prepare",
      data: { dispatchKey, estimateMinor: 7, modelId: "fixture" },
    });
    const reservation = await tx.usageReservation.create({
      data: {
        workspaceId,
        channelId: t.run.channelId,
        amountMinor: 7n,
        currency: "USD",
        category: "LLM",
        correlationId: step.id,
        idempotencyKey: `m08:${dispatchKey}`,
        expiresAt: new Date(Date.now() + 100_000),
      },
    });
    await tx.providerRequest.create({
      data: {
        workspaceId,
        channelId: t.run.channelId,
        correlationId: step.id,
        providerId: "gemini",
        capabilityId: "fixture",
        currency: "USD",
        estimatedCost: 0.07,
        status: "FAILED",
      },
    });
    const armNonce = legacy ? `legacy:${reservation.id}` : randomUUID();
    await appendTextEvidence(tx, locked, {
      kind: "ARMED",
      nonce: armNonce,
      eventKey: "arm",
      data: json({
        reservationId: reservation.id,
        dispatchKey,
        incarnation,
        ...(!legacy && { sender }),
      }),
    });
    if (legacy)
      await appendTextEvidence(tx, locked, {
        kind: "SENDER_RETIRED",
        nonce: armNonce,
        eventKey: "legacy-drain",
        data: { dispatchKey },
      });
    await foldTextAttempt(tx, t.context, step.id);
    return { reservationId: reservation.id, armNonce };
  });
  const target = { workspaceId, attemptId: step.id, dispatchKey, armNonce, incarnation };
  const common = { target, actor: "operator-fixture", observedAt: new Date().toISOString() };
  const exit = {
    ...common,
    reference: "supervisor-log#11",
    source: "supervisor-exit",
    sender,
    result: "process-exited",
  };
  const receipt = {
    ...common,
    reference: "egress-log#22",
    source: "egress-response",
    googleId: "google-fixture",
  };
  return { step, target, sender, exit, receipt, reservationId };
}
