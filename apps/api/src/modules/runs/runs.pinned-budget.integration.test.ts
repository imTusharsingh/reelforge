import * as mediaPrices from "../scene-media/media-prices.js";
import { ShotSpecSchema } from "@reelforge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import type { PaidTextInvocation, PaidTextResult } from "../usage-budget/text-attempt-runtime.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import { RunsBoundary } from "./runs.boundary.js";
import { runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("pinned run budget", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
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
      vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
      const access = {
        runs: t.runs,
        artifacts: t.artifacts,
        paid: new RunPaidCalls(t.usage, t.store),
        boundary: new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs),
      } as MediaAccess;
      const accounts = new MediaAccounts(access);
      await expect(
        accounts.begin(t.context, run, "media:expensive", {}, 429, "fixture"),
      ).rejects.toThrow("BUDGET_CAP");
      for (const key of ["script", "shots"]) {
        const step = await accounts.begin(
          t.context,
          run,
          `media:text:${key}`,
          {},
          4,
          "fixture",
          true,
        );
        const transport = vi.fn(async (sent: () => Promise<void>): Promise<PaidTextResult> => {
          await sent();
          return {
            output: { draft: key },
            providerJobId: null,
            dispatchKey: step.idempotencyKey,
            usage: {},
          };
        });
        const saved = await accounts.dispatchTextAttempt(t.context, step, transport);
        await accounts.complete(t.context, step, saved);
        expect(transport).toHaveBeenCalledOnce();
        expect(
          await t.db.usageReservation.findMany({ where: { correlationId: step.id } }),
        ).toMatchObject([
          { idempotencyKey: `m08:${step.idempotencyKey}`, status: "COMMITTED", committedMinor: 4n },
        ]);
        expect(
          await t.db.textAttemptProjection.findFirstOrThrow({ where: { attemptId: step.id } }),
        ).toMatchObject({ netMinor: 4, reservedMinor: 0 });
        const intent = await t.db.runEvent.findFirstOrThrow({
          where: { type: "media_intent", stepId: step.id },
        });
        expect(intent.payload).toMatchObject({
          costMinor: 4,
          cumulativeMinor: key === "shots" ? 8 : 4,
          warn: key === "shots",
        });
      }
      const blocked = vi.fn<PaidTextInvocation<unknown>>();
      if (period !== "RUN") {
        const pre = await accounts.begin(t.context, run, "media:text:pre", {}, 16, "fixture", true);
        await expect(accounts.dispatchTextAttempt(t.context, pre, blocked)).rejects.toMatchObject({
          code: "BUDGET_EXHAUSTED",
        });
        expect(blocked).not.toHaveBeenCalled();
        expect(await t.db.usageReservation.count({ where: { correlationId: pre.id } })).toBe(0);
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
      ).toMatchObject({ targetMinor: 6, hardCapMinor: 428, spentMinor: 8, reservedMinor: 0 });
      expect(
        await t.db.runEvent.findFirstOrThrow({
          where: { runId: run.id, type: "budget_estimated" },
        }),
      ).toMatchObject({ payload: expect.objectContaining({ warn: true }) });
      if (period === "RUN") {
        await expect(
          accounts.begin(t.context, run, "media:text:post", {}, 421, "fixture", true),
        ).rejects.toThrow("BUDGET_CAP");
        expect(
          await t.db.videoRunStep.count({ where: { runId: run.id, key: "media:text:post" } }),
        ).toBe(0);
        return;
      }
      const after = await accounts.begin(
        t.context,
        run,
        "media:text:post",
        {},
        16,
        "fixture",
        true,
      );
      await expect(accounts.dispatchTextAttempt(t.context, after, blocked)).rejects.toMatchObject({
        code: "BUDGET_EXHAUSTED",
      });
      await t.usage.upsertBudget(t.context, {
        currency: "USD",
        dailyLimitMinor: 5,
        reason: "lower workspace policy",
      });
      const lower = await accounts.begin(
        t.context,
        run,
        "media:text:workspace",
        {},
        6,
        "fixture",
        true,
      );
      await expect(accounts.dispatchTextAttempt(t.context, lower, blocked)).rejects.toMatchObject({
        code: "BUDGET_EXHAUSTED",
      });
      expect(blocked).not.toHaveBeenCalled();
      expect(
        await t.db.usageReservation.count({
          where: { correlationId: { in: [after.id, lower.id] } },
        }),
      ).toBe(0);
    },
  );
});
