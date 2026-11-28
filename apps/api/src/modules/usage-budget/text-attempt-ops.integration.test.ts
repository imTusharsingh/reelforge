import { armFixture } from "./text-attempt-ops.fixture.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { foldTextAttempt } from "./text-attempt-fold.js";
import {
  ingestMatchedTextReceipt,
  ingestMatchedTextRejection,
} from "./text-attempt-receipt-recovery.js";
import { canOwnerConfirmText } from "./text-attempt-owner.js";
import { appendTextEvidence, lockTextAttempt, readTextAttempt } from "./text-attempt-store.js";
import { retireExitedTextSender } from "./text-sender-retirement.js";

describe.skipIf(!process.env.DATABASE_URL)("DB operator paid text recovery", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());

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
    expect(await canOwnerConfirmText(t.db, step, t.context, t.artifacts)).toBe(false);
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
    expect(await canOwnerConfirmText(t.db, step, t.context, t.artifacts)).toBe(true);
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
    expect(await canOwnerConfirmText(t.db, step, t.context, t.artifacts)).toBe(false);
    await ingestMatchedTextReceipt(t.db, receipt);
    expect(await canOwnerConfirmText(t.db, step, t.context, t.artifacts)).toBe(true);
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
    expect(await canOwnerConfirmText(t.db, step, t.context, t.artifacts)).toBe(false);
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

  it.each([false, true])(
    "preserves the first verified posting on contradictory evidence (401 first %s)",
    async (rejectFirst) => {
      const t = await fixture.tenant();
      const { step, exit, receipt, reservationId } = await armFixture(t);
      await t.db.budgetEnvelope.create({
        data: {
          workspaceId: t.run.workspaceId,
          runId: t.run.id,
          targetMinor: 7,
          hardCapMinor: 7,
          baseEstimateMinor: 7,
          spentMinor: 0,
          reservedMinor: 7,
        },
      });
      await retireExitedTextSender(t.db, exit);
      const charge = (): Promise<void> =>
        ingestMatchedTextReceipt(t.db, { ...receipt, actualMinor: 20, currency: "USD" });
      const { googleId: _id, ...audit } = receipt;
      const reject = (): Promise<void> =>
        ingestMatchedTextRejection(t.db, {
          ...audit,
          reference: "typed-error",
          httpStatus: 401,
          code: "UNAUTHENTICATED",
        });
      if (rejectFirst) {
        await reject();
        await expect(charge()).rejects.toThrow("Contradictory");
      } else {
        await charge();
        await charge();
        expect((await t.usage.listBudgets(t.context))[0]?.periods).toEqual(
          expect.arrayContaining([expect.objectContaining({ consumedMinor: 20 })]),
        );
        await expect(reject()).rejects.toThrow("Contradictory");
        vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
        await t.control.abandonTerminalText(t.context, step.runId, step.id);
      }
      expect(
        await t.db.textAttemptEvidence.count({
          where: { attemptId: step.id, kind: "QUARANTINED" },
        }),
      ).toBe(1);
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: step.runId } }),
      ).toMatchObject({
        reservedMinor: 0,
        spentMinor: rejectFirst ? 0 : 20,
        overageMinor: rejectFirst ? 0 : 13,
      });
      expect(
        await t.db.usageReservation.findUniqueOrThrow({ where: { id: reservationId } }),
      ).toMatchObject({
        status: rejectFirst ? "RELEASED" : "COMMITTED",
        committedMinor: rejectFirst ? null : 20n,
      });
    },
  );

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
