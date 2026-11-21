import { describe, expect, it, vi } from "vitest";
import { ShotSpecSchema } from "@reelforge/contracts";
import { generating, runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("polled video refusals", () => {
  const fixture = runsFixture();
  it.each(["success", "refused", "budget"] as const)(
    "replays one same-provider rewrite through %s",
    async (outcome) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const db = t.store.scoped(t.context);
      const source = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "shot-0" },
      });
      await db.videoRunStep.updateMany({
        where: { runId: run.id, key: { startsWith: "shot-" }, id: { not: source.id } },
        data: { state: "SKIPPED" },
      });
      const provider = t.generation.provider;
      const submit = vi.spyOn(provider, "submit");
      const fallback = vi.spyOn(t.generation.fallbackProvider, "submit");
      const poll = vi
        .spyOn(provider, "poll")
        .mockResolvedValueOnce("running")
        .mockResolvedValue("refused");
      const job = t.runs.job(t.context, run.id, source.id);
      expect(await t.engine.process(job)).toBe(12000);
      await Promise.all([t.engine.process(job), t.engine.process(job)]);
      await t.engine.process(job);
      const steps = await db.videoRunStep.findMany({
        where: { runId: run.id, key: source.key },
        orderBy: { attempt: "asc" },
      });
      expect(steps).toHaveLength(2);
      const [first, rewrite] = steps;
      expect(first).toMatchObject({
        state: "SKIPPED",
        error: { code: "PROVIDER_REFUSED", rewriteCount: 0 },
      });
      expect(rewrite).toMatchObject({
        state: "PENDING",
        output: { refusalRewrite: { sourceStepId: source.id, providerId: provider.providerId } },
      });
      expect(ShotSpecSchema.parse(rewrite!.input).motionPrompt).not.toBe(
        ShotSpecSchema.parse(source.input).motionPrompt,
      );
      const reservations = (): ReturnType<typeof t.db.usageReservation.findMany> =>
        t.db.usageReservation.findMany({
          where: { workspaceId: t.context.workspaceId },
          orderBy: { createdAt: "asc" },
        });
      expect(await reservations()).toMatchObject([
        { status: "COMMITTED", committedMinor: BigInt(first!.costMinor!) },
      ]);
      await db.budgetEnvelope.updateMany({
        where: { runId: run.id },
        data: {
          route: "FALLBACK",
          ...(outcome === "budget"
            ? { baseEstimateMinor: first!.costMinor!, reshootReserveMinor: 0 }
            : {}),
        },
      });
      const replacement = t.runs.job(t.context, run.id, rewrite!.id);
      if (outcome === "budget") {
        await expect(t.engine.process(replacement)).rejects.toThrow("Envelope exhausted");
        expect((await t.store.get(t.context, run.id)).state).toBe("PAUSED_BUDGET");
        expect(await reservations()).toHaveLength(1);
        expect(submit).toHaveBeenCalledOnce();
      } else {
        poll
          .mockResolvedValueOnce("running")
          .mockResolvedValue(outcome === "refused" ? "refused" : "succeeded");
        expect(await t.engine.process(replacement)).toBe(12000);
        expect(await reservations()).toMatchObject([
          { status: "COMMITTED" },
          { status: "RESERVED", correlationId: rewrite!.id },
        ]);
        await t.engine.process(replacement);
        await t.engine.process(replacement);
        await t.engine.process(t.runs.job(t.context, run.id));
        expect((await t.store.get(t.context, run.id)).state).toBe(
          outcome === "refused" ? "NEEDS_HUMAN" : "ASSEMBLING",
        );
        expect(await db.videoRunStep.count({ where: { runId: run.id, key: source.key } })).toBe(2);
        expect(await reservations()).toMatchObject([
          { status: "COMMITTED" },
          { status: "COMMITTED" },
        ]);
        expect(submit.mock.calls.map((call) => call[1])).toEqual([
          source.idempotencyKey,
          rewrite!.idempotencyKey,
        ]);
      }
      expect(fallback).not.toHaveBeenCalled();
    },
  );
});
