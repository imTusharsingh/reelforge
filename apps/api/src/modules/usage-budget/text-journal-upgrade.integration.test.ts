import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Transaction } from "../runs/runs.types.js";
import { armFixture } from "./text-attempt-ops.fixture.js";
import { ingestMatchedTextReceipt } from "./text-attempt-receipt-recovery.js";
import { retireExitedTextSender } from "./text-sender-retirement.js";
import { readTextAttempt } from "./text-attempt-store.js";

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

describe.skipIf(!process.env.DATABASE_URL)("paid text journal admission", () => {
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
});
