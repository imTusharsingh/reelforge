import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import { RunsQueue } from "../runs/runs.queue.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts } from "./media-recovery.fixture.js";

const narrator = { providerId: "gemini", voiceId: "fixture", language: "English", pace: 1 };

async function seedLegacyWriter(t: Tenant): Promise<void> {
  const line = (count: number): string => Array<string>(count).fill("planet").join(" ");
  await t.store.scoped(t.context).videoRunStep.create({
    data: {
      workspaceId: t.context.workspaceId,
      runId: t.run.id,
      key: "media:text:scriptwriter",
      idempotencyKey: `${t.run.id}:legacy-script`,
      state: "SUCCEEDED",
      input: {},
      output: {
        result: {
          output: {
            hook: line(4),
            beats: [line(26), line(26), line(26)],
            payoff: line(4),
            cta: line(4),
            language: "English",
            wordCount: 90,
          },
          promptVersion: {
            role: "scriptwriter",
            version: 2,
            templateVersionId: randomUUID(),
            promptSnapshotId: randomUUID(),
            configSnapshotId: randomUUID(),
            fingerprintSha256: "a".repeat(64),
          },
        },
      },
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)(
  "reference recovery after saved planning rejection",
  () => {
    const fixture = runsFixture();
    it.each([
      ["attached", "succeeded"],
      ["ledger", "succeeded"],
      ["ledger", "failed"],
    ] as const)(
      "settles the %s receipt when the image %s, without new charges",
      async (crash, outcome) => {
        const t = await fixture.tenant("L2", 30, narrator, false);
        const native = fakeMediaPorts(
          t.context.workspaceId,
          t.storage,
          { audio: Buffer.alloc(0), clip: Buffer.alloc(0), image: Buffer.from("fixture image") },
          [],
        );
        const first = bindMedia(t, native);
        const job = t.runs.job(t.context, t.run.id);
        await t.engine.process(job);
        const run = await t.store.get(t.context, t.run.id);
        const submit = vi.spyOn(native.image, "submit");
        const poll = vi.spyOn(native.image, "poll").mockResolvedValue("running");
        const fetch = vi.spyOn(native.image, "fetch");
        const text = vi.spyOn(native.text, "complete");
        const db = t.store.scoped(t.context);
        const key = "reference:accepted";
        if (crash === "ledger") {
          const record = first.access.paid.recordJob.bind(first.access.paid);
          vi.spyOn(first.access.paid, "recordJob").mockImplementation(async (...args) => {
            await record(...args);
            throw new Error("Worker stopped before attaching the image job");
          });
        }
        const attempt = first.jobs.tick(
          t.context,
          run,
          key,
          native.image,
          { prompt: "fixture" },
          4,
          "fixture-image",
          "art-director:v2",
        );
        if (crash === "ledger") await expect(attempt).rejects.toThrow("before attaching");
        else await expect(attempt).resolves.toBeNull();
        const step = await db.videoRunStep.findFirstOrThrow({
          where: { runId: run.id, key: `media:${key}` },
        });
        expect(step.state).toBe(crash === "ledger" ? "RUNNING" : "WAITING_EXTERNAL");
        const unsent = await first.accounts.begin(
          t.context,
          run,
          "media:reference:unsent",
          {},
          4,
          "fixture-image",
        );
        await seedLegacyWriter(t);

        bindMedia(t, native);
        await expect(t.engine.process(job)).rejects.toThrow("readable caption duration");
        expect(await t.store.get(t.context, run.id)).toMatchObject({
          state: "FAILED",
          pauseReason: "PROVIDER_INVALID",
        });

        const enqueue = vi.fn<RunsQueue["enqueue"]>().mockResolvedValue(undefined);
        t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
        await t.engine.recover();
        const jobs = enqueue.mock.calls.filter(([queued]) => queued.runId === run.id);
        expect(jobs.map(([queued]) => queued.stepId)).toEqual([step.id]);
        expect(await t.engine.process({ ...job, stepId: unsent.id })).toBeNull();
        await expect(t.engine.process(jobs[0]![0])).resolves.toBe(12000);
        poll.mockResolvedValue(outcome);
        await expect(t.engine.process(jobs[0]![0])).resolves.toBeNull();
        await expect(t.engine.process(jobs[0]![0])).resolves.toBeNull();
        enqueue.mockClear();
        await t.engine.recover();
        expect(enqueue.mock.calls.filter(([queued]) => queued.runId === run.id)).toHaveLength(0);
        const { providerJobId } = await submit.mock.results[0]!.value;
        expect(await db.videoRunStep.findFirst({ where: { id: step.id } })).toMatchObject({
          providerJobId,
          state: outcome === "succeeded" ? "SUCCEEDED" : "FAILED",
        });
        expect(
          await t.db.usageReservation.findMany({
            where: { workspaceId: run.workspaceId },
            select: { status: true, amountMinor: true, committedMinor: true },
          }),
        ).toEqual([{ status: "COMMITTED", amountMinor: 4n, committedMinor: 4n }]);
        expect(await t.store.get(t.context, run.id)).toMatchObject({
          state: "FAILED",
          pauseReason: "PROVIDER_INVALID",
        });
        expect(submit).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(outcome === "succeeded" ? 1 : 0);
        expect(text).not.toHaveBeenCalled();
      },
    );
  },
);
