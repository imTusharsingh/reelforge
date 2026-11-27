import { expect, it, vi } from "vitest";
import { GeminiText, Interactions, ProviderHttp } from "@reelforge/ai-providers";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { generating, runsFixture } from "./runs.fixture.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);

test("settles an invalid completed interaction with usage and never submits it again", async () => {
  const t = await fixture.tenant();
  const job = t.runs.job(t.context, t.run.id);
  await t.engine.process(job);
  const run = await t.store.get(t.context, t.run.id);
  const native = fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    {
      clip: Buffer.alloc(0),
      image: Buffer.alloc(0),
      audio: Buffer.alloc(0),
    },
    [],
  );
  const { accounts } = bindMedia(t, native);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json({
      status: "completed",
      usage: { input_tokens: 12 },
      steps: [{ type: "model_output", content: [{ type: "text", text: "{invalid" }] }],
    }),
  );
  const port = new GeminiText(
    new Interactions(new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher), {
      save: async (): Promise<never> => {
        throw new Error("Unexpected storage");
      },
    }),
    "fixture-text",
  );
  const step = await accounts.begin(
    t.context,
    run,
    "media:text:scriptwriter",
    {},
    7,
    "fixture-text",
  );
  await accounts.prepare(t.context, run, step, "fixture-text");
  const submit = (): ReturnType<typeof port.complete> =>
    port.complete(
      {
        prompt: "Fixture",
        jsonSchema: {},
        parse: (value) => value,
      },
      step.idempotencyKey,
    );
  await expect(accounts.dispatchText(t.context, step, submit)).rejects.toMatchObject({
    providerJobId: step.idempotencyKey,
  });
  await expect(accounts.dispatchText(t.context, step, submit)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(await t.db.providerRequest.findFirst({ where: { correlationId: step.id } })).toMatchObject(
    {
      status: "FAILED",
      errorCode: "PROVIDER_INVALID_OUTPUT",
      actualCost: null,
      usage: { input_tokens: 12 },
      responseMetadata: { dispatchKey: step.idempotencyKey, costKnown: false },
    },
  );
  expect(
    await t.db.usageReservation.findMany({ where: { workspaceId: t.context.workspaceId } }),
  ).toMatchObject([{ status: "COMMITTED", committedMinor: 7n }]);
  expect(await t.store.get(t.context, t.run.id)).toMatchObject({
    state: "FAILED",
    pauseReason: "PROVIDER_INVALID_OUTPUT",
  });
});

test("explicit resume after clearing an emergency stop preserves GENERATING", async () => {
  const t = await fixture.tenant();
  const run = await generating(t);
  const job = t.runs.job(t.context, run.id);
  t.stop.stopped = true;
  await expect(t.engine.process(job)).rejects.toThrow("halted");
  await expect(t.control.resume(t.context, run.id)).rejects.toThrow("halted");
  t.stop.stopped = false;
  await t.control.resume(t.context, run.id);
  expect(await t.store.get(t.context, run.id)).toMatchObject({
    state: "GENERATING",
    pauseReason: null,
  });
});

test("only an owner can close terminal unknown text and book the estimate once", async () => {
  const t = await fixture.tenant();
  const job = t.runs.job(t.context, t.run.id);
  await t.engine.process(job);
  const run = await t.store.get(t.context, t.run.id);
  const native = fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    { clip: Buffer.alloc(0), image: Buffer.alloc(0), audio: Buffer.alloc(0) },
    [],
  );
  const { accounts } = bindMedia(t, native);
  const step = await accounts.begin(t.context, run, "media:text:scriptwriter", {}, 17, "fixture");
  await accounts.prepare(t.context, run, step, "fixture");
  const submit = vi.fn().mockRejectedValue(new Error("connection closed"));
  await expect(accounts.dispatchText(t.context, step, submit)).rejects.toThrow(
    "RECONCILE_REQUIRED",
  );
  await expect(t.runs.detail(t.context, run.id)).resolves.toMatchObject({
    pinnedHardCapMinor: 800,
    remainingBudgetMinor: 783,
    steps: expect.arrayContaining([
      expect.objectContaining({ id: step.id, awaitingReconciliation: true }),
    ]),
  });
  await expect(
    t.control.abandonTerminalText({ ...t.context, role: "EDITOR" }, run.id, step.id),
  ).rejects.toThrow("owner");
  await expect(t.control.abandon(t.context, run.id, step.id)).rejects.toThrow("Reconcile");
  // A billing investigation can outlast the reservation TTL. The original ledger
  // still counts the estimate until the owner settles it.
  await t.db.usageReservation.updateMany({
    where: { correlationId: step.id },
    data: { status: "EXPIRED" },
  });
  const breakdown = await t.usage.runBreakdown(t.context, run.id);
  expect(breakdown.totals.currencies[0]?.byCategory).toEqual(
    expect.arrayContaining([expect.objectContaining({ category: "LLM", totalMinor: 17 })]),
  );
  await t.control.abandonTerminalText(t.context, run.id, step.id);
  await t.control.abandonTerminalText(t.context, run.id, step.id);
  await t.engine.process(job);
  expect(submit).toHaveBeenCalledOnce();
  expect(await t.store.get(t.context, run.id)).toMatchObject({
    state: "FAILED",
    pauseReason: "OWNER_CONFIRMED_TERMINAL_TEXT",
  });
  expect(await t.db.usageReservation.findMany({ where: { correlationId: step.id } })).toMatchObject(
    [{ category: "LLM", status: "COMMITTED", committedMinor: 17n }],
  );
  const failures = await t.db.runEvent.findMany({
    where: { stepId: step.id, type: "step_failed" },
  });
  expect(failures).toHaveLength(1);
  expect(failures[0]?.payload).toMatchObject({
    confirmedBy: t.context.userId,
    committedEstimateMinor: 17,
  });
});

test("reports effective Brief caps in both spend views", async () => {
  const t = await fixture.tenant();
  const policy = {
    ...t.brief.budgetPolicy,
    targetMinor: 300,
    hardCapMinor: 400,
    dailyLimitMinor: 400,
    monthlyLimitMinor: 400,
  };
  await t.db.channelBrief.create({
    data: {
      workspaceId: t.context.workspaceId,
      channelId: t.run.channelId,
      version: 2,
      document: { ...t.brief, version: 2, budgetPolicy: policy },
    },
  });
  const cap = { channelId: t.run.channelId, dailyLimitMinor: 400, monthlyLimitMinor: 400 };
  const expected = expect.arrayContaining([
    expect.objectContaining({
      effectiveBriefCaps: expect.arrayContaining([expect.objectContaining(cap)]),
    }),
  ]);
  expect(await t.usage.listBudgets(t.context)).toEqual(expected);
  expect((await t.usage.usageSummary(t.context, {})).budgets).toEqual(expected);
});
