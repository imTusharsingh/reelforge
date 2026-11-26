import * as mediaPrices from "../scene-media/media-prices.js";
import { ShotSpecSchema } from "@reelforge/contracts";
import { describe, expect, it, vi } from "vitest";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import { RunsBoundary } from "./runs.boundary.js";
import { runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("pinned run budget", () => {
  const fixture = runsFixture();
  it("refuses over-$8 estimates before media dispatch", async () => {
    const t = await fixture.tenant();
    using price = vi.spyOn(mediaPrices, "clipMoney");
    price.mockImplementation((shot) => ({
      currency: "USD",
      microUsd: 200_000 * shot.durationSeconds,
    }));
    const submit = vi.spyOn(t.generation.provider, "submit");
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await expect(t.engine.process(t.runs.job(t.context, t.run.id))).rejects.toThrow("$8");
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(["DAY", "MONTH", "RUN"] as const)(
    "uses the pinned Brief before and after envelope creation for the %s limit",
    async (period) => {
      const t = await fixture.tenant("L2", 30);
      const policy = {
        ...t.brief.budgetPolicy,
        targetMinor: 6,
        hardCapMinor: 428,
        dailyLimitMinor: period === "DAY" ? 15 : 2000,
        monthlyLimitMinor: period === "MONTH" ? 15 : 18000,
      };
      const append = async (version: number, budgetPolicy: typeof policy): Promise<string> => {
        const id = crypto.randomUUID();
        const { workspaceId, channelId } = t.brief;
        const document = { ...t.brief, id, version, budgetPolicy };
        await t.db.channelBrief.create({ data: { id, workspaceId, channelId, version, document } });
        return id;
      };
      const run = await t.runs.create(t.context, await append(2, policy), "pinned");
      await append(3, t.brief.budgetPolicy);
      const access = {
        runs: t.runs,
        paid: new RunPaidCalls(t.usage, t.store),
        boundary: new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs),
      } as MediaAccess;
      const accounts = new MediaAccounts(access);
      await expect(
        accounts.begin(t.context, run, "media:expensive", {}, 429, "fixture"),
      ).rejects.toThrow("BUDGET_CAP");
      for (const key of ["script", "shots"]) {
        const step = await accounts.begin(t.context, run, `media:text:${key}`, {}, 4, "fixture");
        await accounts.prepare(t.context, run, step, "fixture");
        await accounts.dispatchText(t.context, step, async () => ({ providerJobId: key }));
        await accounts.complete(t.context, step, { providerJobId: key });
        for (const type of ["media_intent", "media_completed"]) {
          const event = await t.db.runEvent.findFirstOrThrow({ where: { type, stepId: step.id } });
          expect(event.payload).toMatchObject({
            costMinor: 4,
            cumulativeMinor: key === "shots" ? 8 : 4,
            warn: key === "shots",
          });
        }
      }
      if (period !== "RUN") {
        const pre = await accounts.begin(t.context, run, "media:pre", {}, 16, "fixture");
        await expect(accounts.prepare(t.context, run, pre, "fixture")).rejects.toMatchObject({
          code: "BUDGET_EXHAUSTED",
        });
      }
      const shots = await t.db.shotSpec.findMany({ where: { runId: t.run.id } });
      for (const shot of shots) {
        const document = ShotSpecSchema.parse(shot.document);
        const id = crypto.randomUUID();
        await t.db.shotSpec.create({
          data: {
            workspaceId: run.workspaceId,
            runId: run.id,
            id,
            ordinal: shot.ordinal,
            version: 1,
            document: { ...document, id, runId: run.id },
          },
        });
      }
      await t.planning.prepare(t.context, run);
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ targetMinor: 6, hardCapMinor: 428 });
      expect(
        await t.db.runEvent.findFirstOrThrow({
          where: { runId: run.id, type: "budget_estimated" },
        }),
      ).toMatchObject({ payload: expect.objectContaining({ warn: true }) });
      if (period === "RUN") {
        await expect(
          accounts.begin(t.context, run, "media:text:post", {}, 421, "fixture"),
        ).rejects.toThrow("BUDGET_CAP");
        expect(
          await t.db.videoRunStep.count({ where: { runId: run.id, key: "media:text:post" } }),
        ).toBe(0);
        return;
      }
      const after = await accounts.begin(t.context, run, "media:post", {}, 16, "fixture");
      await expect(accounts.prepare(t.context, run, after, "fixture")).rejects.toMatchObject({
        code: "BUDGET_EXHAUSTED",
      });
      await t.usage.upsertBudget(t.context, {
        currency: "USD",
        dailyLimitMinor: 5,
        reason: "lower workspace policy",
      });
      const lower = await accounts.begin(t.context, run, "media:workspace", {}, 6, "fixture");
      await expect(accounts.prepare(t.context, run, lower, "fixture")).rejects.toMatchObject({
        code: "BUDGET_EXHAUSTED",
      });
    },
  );
});
