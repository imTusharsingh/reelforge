import { describe, expect, it, vi } from "vitest";
import {
  admitSibling,
  clipUri,
  expectBillingReconciliation,
  expectBudgetConsumption,
  expectSameClip,
  expectSettled,
  failingClip,
  lateClipCases,
  receiptAdjustments,
  recoverBeforeLateFetch,
  stagedClip,
} from "./runs.staged-clip.fixture.js";
import { runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Late video receipts and delivery failures", () => {
  const fixture = runsFixture();

  it.each(lateClipCases)(
    "keeps the settled clip after a late $kind response from $provider with $seconds billed seconds",
    async ({ provider, kind, seconds, pause }) => {
      const f = await stagedClip(await fixture.tenant(), kind === "valid" ? 118 : 400, provider);
      const { t, run, shot, job, native } = f;
      const put = vi.spyOn(t.artifacts, "put");
      const recoveredSeconds = kind === "job GET 503" ? seconds : 10;
      const settled = await recoverBeforeLateFetch(
        f,
        recoveredSeconds,
        seconds,
        async () => {
          await expectSettled(f, recoveredSeconds);
          expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
          if (kind !== "valid") return failingClip(f, kind, seconds);
        },
        10,
      );
      await t.engine.process(job);
      await expectSettled(f, seconds);
      await expectSameClip(t, settled);
      const events = await t.db.runEvent.findMany({ where: { runId: run.id, stepId: shot.id } });
      expectBillingReconciliation(events, provider === "xai");
      const adjustments = receiptAdjustments(events);
      expect(adjustments).toMatchObject(
        seconds > recoveredSeconds ? [{ payload: { adjustmentMinor: 14, costMinor: 84 } }] : [],
      );
      await expectBudgetConsumption(f, seconds);
      expect(put).toHaveBeenCalledOnce();
      expect(native.submit).toHaveBeenCalledOnce();
      if (kind !== "valid") {
        if (kind !== "job GET 503")
          expect(f.fetcher).toHaveBeenLastCalledWith(clipUri, expect.anything());
        expect(events.filter((e) => e.type === "redundant_clip_discarded")).toMatchObject([
          { payload: { reason: pause } },
        ]);
        expect(await t.store.get(t.context, run.id)).toMatchObject({
          state: "GENERATING",
          pauseReason: null,
        });
        await admitSibling(f);
      } else {
        await expect(
          t.usage.reserve(run.workspaceId, {
            currency: "USD",
            category: "VIDEO_MEDIA",
            amountMinor: 14,
            idempotencyKey: "competing",
          }),
        ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
      }
    },
  );
});
