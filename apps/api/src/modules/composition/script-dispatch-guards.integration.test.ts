import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import { RECOVERY_PRINCIPAL } from "../runs/runs.types.js";
import { RunsQueue } from "../runs/runs.queue.js";
import { scriptFixture } from "../script/planning.fixture.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts } from "./media-recovery.fixture.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);
afterEach(() => vi.unstubAllEnvs());

async function setup(): Promise<{
  t: Tenant;
  post: Mock<ReturnType<typeof fakeMediaPorts>["text"]["complete"]>;
  accounts: ReturnType<typeof bindMedia>["accounts"];
  job: ReturnType<Tenant["runs"]["job"]>;
}> {
  const narrator = {
    providerId: "gemini" as const,
    voiceId: "fixture",
    language: "English",
    pace: 1,
  };
  const t = await fixture.tenant("L2", 30, narrator, false);
  const bytes = { clip: Buffer.alloc(0), image: Buffer.alloc(0), audio: Buffer.alloc(0) };
  const native = fakeMediaPorts(t.context.workspaceId, t.storage, bytes, [
    { ...scriptFixture(), wordCount: 1 },
  ]);
  vi.stubEnv("GEMINI_TEXT_MODEL", "fixture-text");
  const { accounts } = bindMedia(t, native);
  const post = vi.spyOn(native.text, "complete");
  const job = t.runs.job(t.context, t.run.id);
  await t.engine.process(job);
  return { t, post, accounts, job };
}

test("a run envelope that only covers the first call refuses the repair and closes SCRIPTING", async () => {
  const { t, post, job } = await setup();
  await t.db.budgetEnvelope.create({
    data: {
      workspaceId: t.context.workspaceId,
      runId: t.run.id,
      currency: "USD",
      targetMinor: 17,
      baseEstimateMinor: 17,
      reshootReserveMinor: 0,
      hardCapMinor: 17,
      route: "PRIMARY",
    },
  });
  await expect(t.engine.process(job)).rejects.toThrow("BUDGET_CAP");
  await t.engine.process(job);
  expect(post).toHaveBeenCalledOnce();
  expect(await t.store.get(t.context, t.run.id)).toMatchObject({
    state: "FAILED",
    pauseReason: "BUDGET_CAP",
  });
  expect(await t.db.videoRunStep.count({ where: { runId: t.run.id, state: "RUNNING" } })).toBe(0);
  expect(
    await t.db.usageReservation.findMany({ where: { workspaceId: t.context.workspaceId } }),
  ).toMatchObject([{ status: "COMMITTED", committedMinor: 17n }]);
});

test("the pinned daily cap can refuse the repair during reservation", async () => {
  const { t, post } = await setup();
  const id = crypto.randomUUID();
  const brief = {
    ...t.brief,
    id,
    version: 2,
    budgetPolicy: { ...t.brief.budgetPolicy, dailyLimitMinor: 17 },
  };
  await t.db.channelBrief.create({
    data: {
      id,
      workspaceId: brief.workspaceId,
      channelId: brief.channelId,
      version: 2,
      document: brief,
    },
  });
  const run = await t.runs.create(t.context, id, "daily-limit");
  const job = t.runs.job(t.context, run.id);
  await t.engine.process(job);
  await expect(t.engine.process(job)).rejects.toThrow(/budget/i);
  await t.engine.process(job);
  expect(post).toHaveBeenCalledOnce();
  expect(await t.store.get(t.context, run.id)).toMatchObject({
    state: "FAILED",
    pauseReason: "BUDGET_EXHAUSTED",
  });
  const repair = await t.db.videoRunStep.findFirstOrThrow({
    where: { runId: run.id, key: "media:text:scriptwriter", attempt: 2 },
  });
  expect(repair).toMatchObject({ costMinor: 0, error: { code: "NOT_DISPATCHED" } });
  expect(await t.db.usageReservation.count({ where: { correlationId: repair.id } })).toBe(0);
});

test("with paid text disabled the attempt closes at zero and no parent waits for reconciliation", async () => {
  const { t, post, job } = await setup();
  vi.stubEnv("PAID_TEXT_V3_ENABLED", undefined);
  await expect(t.engine.process(job)).rejects.toThrow("Paid text dispatch is disabled");
  await t.engine.recover();
  await t.engine.process(job);
  expect(post).not.toHaveBeenCalled();
  const where = { runId: t.run.id };
  const step = await t.db.videoRunStep.findFirstOrThrow({
    where: { ...where, key: "media:text:scriptwriter" },
  });
  expect(step).toMatchObject({
    state: "CANCELLED",
    costMinor: 0,
    error: { code: "NOT_DISPATCHED" },
  });
  expect(
    await t.db.textAttemptEvidence.count({ where: { attemptId: step.id, kind: "NOT_DISPATCHED" } }),
  ).toBe(1);
  expect(await t.db.usageReservation.count({ where: { correlationId: step.id } })).toBe(0);
  expect(await t.db.videoRunStep.count({ where: { ...where, state: "RUNNING" } })).toBe(0);
  expect(await t.store.get(t.context, t.run.id)).toMatchObject({
    state: "FAILED",
    pauseReason: "Paid text dispatch is disabled",
  });
});

test("restart closes an orphaned preparation at zero and leaves the held run for its owner", async () => {
  const { t, accounts, post, job } = await setup();
  const run = await t.store.get(t.context, t.run.id);
  const step = await accounts.begin(
    t.context,
    run,
    "media:text:scriptwriter",
    {},
    17,
    "fixture-text",
    true,
  );
  const pauseReason = `RECONCILE_REQUIRED: provider submission outcome unknown (${step.id})`;
  await t.db.videoRun.update({
    where: { id: run.id },
    data: { pauseReason, revision: { increment: 1 } },
  });
  const enqueue = vi.fn<RunsQueue["enqueue"]>().mockResolvedValue(undefined);
  t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
  await t.engine.recover();
  await t.engine.recover();
  expect(enqueue).not.toHaveBeenCalled();
  await t.engine.process({ ...job, userId: RECOVERY_PRINCIPAL });
  await t.engine.process(job);
  expect(post).not.toHaveBeenCalled();
  expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
    state: "CANCELLED",
    costMinor: 0,
    output: { closedBy: "NOT_DISPATCHED" },
  });
  expect(await t.store.get(t.context, run.id)).toMatchObject({ state: "SCRIPTING", pauseReason });
  await expect(t.control.resume({ ...t.context, role: "EDITOR" }, run.id)).rejects.toThrow("owner");
  await t.control.resume(t.context, run.id);
  expect(enqueue).toHaveBeenCalledOnce();
});

it("documents the paid text opt-in in the template and setup guide", () => {
  const root = new URL("../../../../../", import.meta.url);
  expect(readFileSync(new URL(".env.example", root), "utf8")).toMatch(/^PAID_TEXT_V3_ENABLED=0$/m);
  expect(readFileSync(new URL("README.md", root), "utf8")).toContain("PAID_TEXT_V3_ENABLED=1");
});
