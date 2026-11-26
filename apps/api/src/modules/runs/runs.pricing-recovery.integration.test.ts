import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readReceiptBudget } from "../usage-budget/run-shot-receipt.js";
import { MissingVideoPricing } from "../scene-media/media-prices.js";
import { runsFixture } from "./runs.fixture.js";
import { eightSecondShot, stagedClip } from "./runs.staged-clip.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("legacy video pricing", () => {
  const fixture = runsFixture();
  it("keeps each unpriced job on hold until its own admission terms are restored", async () => {
    const { t, shot, job, run, fetcher, wire, native } = await stagedClip(
      await fixture.tenant(),
      400,
    );
    const steps = t.store.scoped(t.context).videoRunStep;
    const sibling = await eightSecondShot(t, run.id, 1);
    const otherJob = t.runs.job(t.context, run.id, sibling.id);
    const running = (): Response => Response.json({ status: "in_progress" });
    fetcher
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(wire.queued("sibling"))
      .mockResolvedValueOnce(running());
    expect(await t.engine.process(job)).toBe(12000);
    expect(await t.engine.process(otherJob)).toBe(12000);
    const admitted = await steps.findMany({ where: { id: { in: [shot.id, sibling.id] } } });
    for (const step of admitted) {
      const receiptBudget = readReceiptBudget(step.output)!;
      await steps.updateMany({ where: { id: step.id }, data: { output: { receiptBudget } } });
    }
    fetcher.mockClear();
    for (const work of [job, otherJob, otherJob, job])
      await expect(t.engine.process(work)).rejects.toThrow(MissingVideoPricing);
    expect(fetcher).not.toHaveBeenCalled();

    for (const work of [job, otherJob]) {
      const original = admitted.find((step) => step.id === work.stepId)!;
      await steps.updateMany({ where: { id: original.id }, data: { output: original.output! } });
      fetcher.mockResolvedValueOnce(wire.completed(5)).mockResolvedValueOnce(wire.completed(5));
      await t.engine.process(work);
      expect((await t.store.get(t.context, run.id)).pauseReason).toBe(
        work === job ? MissingVideoPricing.hold(sibling.id) : null,
      );
    }
    expect(native.submit).toHaveBeenCalledTimes(2);
    expect(native.fetch).toHaveBeenCalledTimes(2);
  });

  it("delivers an already priced, staged legacy clip without another provider request", async () => {
    const { t, shot, job, fetcher, wire, native } = await stagedClip(await fixture.tenant());
    fetcher.mockResolvedValueOnce(wire.completed(8)).mockResolvedValueOnce(wire.completed(10));
    vi.spyOn(t.artifacts, "put").mockRejectedValueOnce(new Error("storage offline"));
    await expect(t.engine.process(job)).rejects.toThrow("storage offline");
    const steps = t.store.scoped(t.context).videoRunStep;
    const current = await steps.findFirstOrThrow({ where: { id: shot.id } });
    const legacy = z.object({ pendingMedia: z.json(), receipt: z.json() }).parse(current.output);
    await steps.updateMany({ where: { id: shot.id }, data: { output: legacy } });
    fetcher.mockClear();
    await t.engine.process(job);
    expect(await steps.findFirstOrThrow({ where: { id: shot.id } })).toMatchObject({
      state: "SUCCEEDED",
      costMinor: 70,
      output: { receipt: { seconds: 10 } },
    });
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: shot.id } }),
    ).toMatchObject({
      status: "COMMITTED",
      committedMinor: 70n,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(native.submit).toHaveBeenCalledOnce();
  });
});
