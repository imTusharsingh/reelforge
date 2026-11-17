import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { MediaAccounts } from "./media-accounts.js";
import type { MediaAccess } from "./media-access.js";
describe.skipIf(!process.env.DATABASE_URL)("V5 persisted media reservations", () => {
  const fixture = runsFixture();
  beforeEach(() => vi.stubEnv("PIPELINE_V2", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("claims once, stores real ids and accounts planning charges when the envelope arrives", async () => {
    const t = await fixture.tenant();
    const paid = new RunPaidCalls(new UsageBudgetService(t.db, () => new Date()), t.store);
    const access = {
      runs: t.runs,
      paid,
      boundary: { check: async (): Promise<void> => {} },
    } as unknown as MediaAccess;
    const accounts = new MediaAccounts(access);
    const step = await accounts.begin(
      t.context,
      t.run,
      "media:reference:test",
      {},
      4,
      "configured-image-model",
    );
    await accounts.reserve(t.context, t.run, step, "configured-image-model");
    await accounts.complete(t.context, step, { receipt: "fixture" });
    expect(
      (await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } }))
        .providerId,
    ).toBe("gemini");
    const replay = await accounts.begin(
      t.context,
      t.run,
      step.key,
      {},
      4,
      "configured-image-model",
    );
    expect(replay.id).toBe(step.id);
    await t.store.scoped(t.context).budgetEnvelope.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        baseEstimateMinor: 500,
        reshootReserveMinor: 100,
      },
    });
    await accounts.sync(t.context, t.run);
    await accounts.sync(t.context, t.run);
    expect(
      (
        await t.store
          .scoped(t.context)
          .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } })
      ).spentMinor,
    ).toBe(4);
    const next = await accounts.begin(
      t.context,
      t.run,
      "media:music",
      {},
      8,
      "configured-music-model",
    );
    await accounts.reserve(t.context, t.run, next, "configured-music-model");
    await accounts.complete(t.context, next, { receipt: "fixture" });
    await accounts.complete(t.context, next, { receipt: "fixture" });
    const budget = await t.store
      .scoped(t.context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } });
    expect(budget.spentMinor).toBe(12);
    expect(budget.reservedMinor).toBe(0);
    await expect(
      accounts.begin(t.context, t.run, "media:too-much", {}, 900, "model"),
    ).rejects.toThrow("BUDGET_CAP");
    const foreign = await fixture.tenant();
    await expect(
      accounts.begin(foreign.context, t.run, "media:foreign", {}, 1, "model"),
    ).rejects.toThrow();
  });
});
