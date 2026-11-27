import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import { json, type Step } from "../runs/runs.types.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import { drainedLegacyIncarnation, type TextAttemptOpsTarget } from "./text-attempt-ops-schema.js";
import {
  ingestMatchedTextReceipt,
  ingestMatchedTextRejection,
} from "./text-attempt-receipt-recovery.js";
import { canOwnerConfirmText } from "./text-attempt-owner.js";
import { appendTextEvidence, lockTextAttempt, readTextAttempt } from "./text-attempt-store.js";
import { currentTextSenderIdentity, type TextSenderIdentity } from "./text-sender-identity.js";
import { retireExitedTextSender } from "./text-sender-retirement.js";

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

async function armFixture(t: Tenant, legacy = false): Promise<ArmFixture> {
  const workspaceId = t.context.workspaceId;
  const dispatchKey = randomUUID();
  const step = await t.db.videoRunStep.create({
    data: {
      workspaceId,
      runId: t.run.id,
      key: "media:text:scriptwriter",
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

describe.skipIf(!process.env.DATABASE_URL)("DB operator paid text recovery", () => {
  const fixture = runsFixture();

  it("keeps an unconfirmed sender held until independent exact evidence is verified", async () => {
    const t = await fixture.tenant();
    const { step, target, sender, exit, receipt } = await armFixture(t);
    await expect(ingestMatchedTextReceipt(t.db, receipt)).rejects.toThrow(
      "Verify sender retirement",
    );
    await expect(
      retireExitedTextSender(t.db, { ...exit, sender: { ...sender, pid: sender.pid + 1 } }),
    ).rejects.toThrow("does not match the stored sender");
    await expect(
      retireExitedTextSender(t.db, { ...exit, target: { ...target, armNonce: randomUUID() } }),
    ).rejects.toThrow("does not match the exact");
    await expect(
      retireExitedTextSender(t.db, { ...exit, target: { ...target, workspaceId: randomUUID() } }),
    ).rejects.toThrow("attempt not found");
    await retireExitedTextSender(t.db, exit);
    await retireExitedTextSender(t.db, exit);
    expect(await canOwnerConfirmText(t.db, step)).toBe(false);
    expect(await readTextAttempt(t.db, step)).toMatchObject({
      phase: "ARMED",
      senderRetired: true,
      positiveSent: false,
      reservedMinor: 7,
    });
    await expect(
      ingestMatchedTextReceipt(t.db, { ...receipt, googleId: target.dispatchKey }),
    ).rejects.toThrow("must be distinct");
    await expect(
      ingestMatchedTextReceipt(t.db, {
        ...receipt,
        target: { ...target, dispatchKey: randomUUID() },
      }),
    ).rejects.toThrow("does not match the exact");
    await expect(
      ingestMatchedTextReceipt(t.db, { ...receipt, source: "owner_reported" }),
    ).rejects.toThrow();
    await ingestMatchedTextReceipt(t.db, receipt);
    await ingestMatchedTextReceipt(t.db, receipt);
    expect(await canOwnerConfirmText(t.db, step)).toBe(true);
    expect(await readTextAttempt(t.db, step)).toMatchObject({
      phase: "SENT",
      googleId: receipt.googleId,
      reservedMinor: 7,
      usable: false,
    });
    expect(await t.db.textAttemptEvidence.count({ where: { attemptId: step.id } })).toBe(4);
  });

  it("allows exact provider evidence for imported arms retired by the legacy drain", async () => {
    const t = await fixture.tenant();
    const { step, exit, receipt } = await armFixture(t, true);
    await expect(retireExitedTextSender(t.db, exit)).rejects.toThrow();
    expect(await canOwnerConfirmText(t.db, step)).toBe(false);
    await ingestMatchedTextReceipt(t.db, receipt);
    expect(await canOwnerConfirmText(t.db, step)).toBe(true);
  });

  it("only releases an arm for an independently confirmed typed rejection", async () => {
    const t = await fixture.tenant();
    const { step, exit, receipt, reservationId } = await armFixture(t);
    await retireExitedTextSender(t.db, exit);
    const { googleId: _id, ...rejected } = receipt;
    await expect(
      ingestMatchedTextRejection(t.db, { ...rejected, httpStatus: 503, code: "UNAUTHENTICATED" }),
    ).rejects.toThrow("do not prove");
    await expect(
      ingestMatchedTextRejection(t.db, { ...rejected, httpStatus: 401, code: "PERMISSION_DENIED" }),
    ).rejects.toThrow("do not prove");
    const matched = { ...rejected, httpStatus: 401, code: "UNAUTHENTICATED" };
    await ingestMatchedTextRejection(t.db, matched);
    await ingestMatchedTextRejection(t.db, matched);
    expect(await canOwnerConfirmText(t.db, step)).toBe(false);
    expect(await t.db.usageReservation.findUnique({ where: { id: reservationId } })).toMatchObject({
      status: "RELEASED",
    });
    expect(await readTextAttempt(t.db, step)).toMatchObject({
      phase: "REJECTED",
      reservedMinor: 0,
      grossMinor: 0,
      netMinor: 0,
    });
  });

  it("keeps exact late billing and reverses a posted estimate on a distinct typed rejection", async () => {
    const t = await fixture.tenant();
    const { step, exit, receipt, reservationId, target } = await armFixture(t);
    await retireExitedTextSender(t.db, exit);
    await ingestMatchedTextReceipt(t.db, receipt);
    await t.db.$transaction(async (tx) => {
      const current = await lockTextAttempt(tx, target.workspaceId, step.id);
      await appendTextEvidence(tx, current, {
        kind: "OWNER_CONFIRMED",
        eventKey: "fixture-owner-confirm",
        data: { dispatchKey: target.dispatchKey },
      });
      await foldTextAttempt(tx, t.context, step.id);
    });
    await expect(
      ingestMatchedTextReceipt(t.db, {
        ...receipt,
        reference: "billing-trace#23",
        currency: "EUR",
        actualMinor: 4,
      }),
    ).rejects.toThrow("armed attempt currency");
    await ingestMatchedTextReceipt(t.db, {
      ...receipt,
      reference: "billing-trace#23",
      currency: "USD",
      actualMinor: 0,
    });
    const { googleId: _id, ...rejected } = receipt;
    await ingestMatchedTextRejection(t.db, {
      ...rejected,
      reference: "typed-error#24",
      httpStatus: 400,
      code: "INVALID_ARGUMENT",
    });
    expect(await t.db.usageReservation.findUnique({ where: { id: reservationId } })).toMatchObject({
      status: "COMMITTED",
      committedMinor: 0n,
    });
    expect(await readTextAttempt(t.db, step)).toMatchObject({
      ownerConfirmed: true,
      phase: "REJECTED",
      grossMinor: 0,
      netMinor: 0,
    });
  });
});
