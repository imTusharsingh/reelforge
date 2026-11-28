import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Transaction } from "../runs/runs.types.js";
import { armFixture } from "./text-attempt-ops.fixture.js";
import { ingestMatchedTextReceipt } from "./text-attempt-receipt-recovery.js";
import { retireExitedTextSender } from "./text-sender-retirement.js";
import { readTextAttempt } from "./text-attempt-store.js";
import { importLegacyTextAttempts } from "./legacy-text-import.js";

function enableRecovery(t: Tenant): void {
  bindMedia(
    t,
    fakeMediaPorts(
      t.run.workspaceId,
      t.storage,
      { clip: Buffer.alloc(0), image: Buffer.alloc(0), audio: Buffer.alloc(0) },
      [],
    ),
  );
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
}

describe.skipIf(!process.env.DATABASE_URL)("paid text journal upgrade and admission", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());

  it("denies a competing reservation after verified evidence commits and settlement rolls back", async () => {
    const t = await fixture.tenant();
    const { step, receipt, exit, reservationId } = await armFixture(t);
    const { workspaceId, channelId } = t.run;
    await t.db.usageBudget.updateMany({ where: { workspaceId }, data: { dailyLimitMinor: 20n } });
    await retireExitedTextSender(t.db, exit);
    const transaction = t.db.$transaction.bind(t.db);
    const wrap = (work: (tx: Transaction) => Promise<unknown>): Promise<unknown> =>
      transaction(async (tx) => {
        const result = await work(tx);
        const projection = await tx.textAttemptProjection.findFirstOrThrow({
          where: { attemptId: step.id },
        });
        if (projection.netMinor === 20) throw new Error("aborted settlement");
        return result;
      });
    const spy = vi.spyOn(t.db, "$transaction").mockImplementation(wrap as typeof t.db.$transaction);
    try {
      await expect(
        ingestMatchedTextReceipt(t.db, { ...receipt, currency: "USD", actualMinor: 20 }),
      ).rejects.toThrow("aborted settlement");
    } finally {
      spy.mockRestore();
    }
    expect(await readTextAttempt(t.db, step)).toMatchObject({ actualMinor: 20 });
    expect(
      await t.db.usageReservation.findUniqueOrThrow({ where: { id: reservationId } }),
    ).toMatchObject({ status: "RESERVED", amountMinor: 7n });
    await expect(
      t.usage.reserve(workspaceId, {
        channelId,
        idempotencyKey: "competing",
        category: "VIDEO_MEDIA",
        currency: "USD",
        amountMinor: 1,
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED", details: { consumedMinor: 20 } });
    enableRecovery(t);
    await t.engine.recover();
    expect(
      await t.db.usageReservation.findUniqueOrThrow({ where: { id: reservationId } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: 20n });
  });

  it.each(["positive then 401", "503", "missing status"])(
    "inventories and repairs the previous writer's %s journal exactly once",
    async (mode) => {
      const t = await fixture.tenant();
      const { step, target, receipt, reservationId, exit } = await armFixture(t);
      await retireExitedTextSender(t.db, exit);
      const billed = mode === "positive then 401";
      if (billed)
        await ingestMatchedTextReceipt(t.db, { ...receipt, currency: "USD", actualMinor: 20 });
      const { workspaceId, attemptId, dispatchKey, armNonce } = target;
      const where = { workspaceId, attemptId };
      const sequence = (await t.db.textAttemptEvidence.count({ where })) + 1;
      const eventKey = `observation:${armNonce}:REJECTED`;
      await t.db.$transaction(async (tx) => {
        await tx.textAttemptEvidence.create({
          data: {
            ...where,
            sequence,
            eventKey,
            nonce: armNonce,
            kind: "REJECTED",
            data: {
              dispatchKey,
              code: "UNAUTHENTICATED",
              ...(mode !== "missing status" && { httpStatus: billed ? 401 : 503 }),
            },
          },
        });
        await tx.textAttemptProjection.update({
          where: { workspaceId_attemptId: where },
          data: { appliedSequence: sequence, reservedMinor: 0, grossMinor: 0, netMinor: 0 },
        });
        await tx.usageReservation.update({
          where: { id: reservationId },
          data: {
            status: "RELEASED",
            committedMinor: null,
            releasedAt: new Date(),
            releaseReason: "UNAUTHENTICATED",
          },
        });
        await tx.providerRequest.updateMany({
          where: { workspaceId, correlationId: attemptId },
          data: { actualCost: 0, errorCode: "UNAUTHENTICATED" },
        });
        await tx.videoRunStep.update({
          where: { id: attemptId },
          data: { state: "FAILED", costMinor: 0 },
        });
        await tx.videoRun.update({
          where: { id: step.runId },
          data: { state: "FAILED", pauseReason: "UNAUTHENTICATED" },
        });
      });
      vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
      const dry = await importLegacyTextAttempts(t.db, { workspaceId });
      expect(dry.attempts).toContainEqual(
        expect.objectContaining({
          attemptId,
          action: "requires-reconciliation",
          rejections: [expect.objectContaining({ sequence, eventKey })],
        }),
      );
      const options = {
        workspaceId,
        apply: true,
        oldWritersDrained: true,
        auditId: "prior-writer-upgrade",
      };
      expect((await importLegacyTextAttempts(t.db, options)).attempts[0]?.action).toBe(
        "reconciled",
      );
      expect((await importLegacyTextAttempts(t.db, options)).attempts[0]?.action).toBe(
        "already-imported",
      );
      enableRecovery(t);
      await t.engine.recover();
      await t.engine.recover();
      expect(
        await t.db.textAttemptEvidence.findMany({ where: { ...where, kind: "JOURNAL_REPAIR" } }),
      ).toMatchObject([
        { data: { auditId: options.auditId, rejections: [{ sequence, eventKey }] } },
      ]);
      expect(await t.db.textAttemptEvidence.count({ where: { ...where, kind: "ARMED" } })).toBe(1);
      expect(
        await t.db.usageReservation.findUniqueOrThrow({ where: { id: reservationId } }),
      ).toMatchObject(
        billed
          ? { status: "COMMITTED", committedMinor: 20n }
          : { status: "RESERVED", amountMinor: 7n, committedMinor: null },
      );
      expect(await t.db.videoRun.findUniqueOrThrow({ where: { id: step.runId } })).toMatchObject({
        state: "FAILED",
      });
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(
        billed ? 20 : 7,
      );
    },
  );
});
