import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Queue, Worker } from "bullmq";
import { parseRedisConnection } from "../orchestration/orchestration.bullmq.js";
import { runsFixture, generating } from "./runs.fixture.js";
import type { RunJob } from "./runs.types.js";

/** Real process termination, real Redis delivery and PostgreSQL step/envelope/ledger persistence. */
describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)(
  "V3 worker SIGKILL recovery",
  () => {
    const fixture = runsFixture();
    beforeEach(() => vi.stubEnv("PIPELINE_V2", "true"));
    afterEach(() => vi.unstubAllEnvs());
    it("reclaims a killed worker's job without another submit or reservation", async () => {
      const t = await fixture.tenant();
      await generating(t);
      const step = await t.store
        .scoped(t.context)
        .videoRunStep.findFirstOrThrow({ where: { runId: t.run.id, key: "shot-0" } });
      const submit = vi.spyOn(t.generation.provider, "submit");
      const poll = vi.spyOn(t.generation.provider, "poll").mockResolvedValue("running");
      // Leave a durable provider id and reservation as a worker would before its first delayed poll.
      expect(await t.engine.process(t.runs.job(t.context, t.run.id, step.id))).toBe(12000);
      const name = `v3-kill-${t.run.id}`;
      const connection = parseRedisConnection(process.env.REDIS_URL!);
      const queue = new Queue<RunJob>(name, { connection });
      await queue.add("poll", t.runs.job(t.context, t.run.id, step.id), { jobId: step.id });
      const script = `
      import { Worker } from 'bullmq';
      const worker = new Worker(process.env.V3_TEST_QUEUE, async () => {
        process.send('claimed');
        await new Promise(() => {});
      }, { connection: JSON.parse(process.env.V3_TEST_CONNECTION), lockDuration: 500, stalledInterval: 500 });
      worker.on('error', () => {});
    `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: new URL("../../..", import.meta.url).pathname,
        env: {
          ...process.env,
          V3_TEST_QUEUE: name,
          V3_TEST_CONNECTION: JSON.stringify(connection),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let replacement: Worker<RunJob> | undefined;
      try {
        await Promise.race([
          once(child, "message", { signal: AbortSignal.timeout(8000) }),
          once(child, "exit").then(() => {
            throw new Error("Child exited before claim");
          }),
        ]);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        const [, signal] = await exited;
        expect(signal).toBe("SIGKILL");
        poll.mockResolvedValue("succeeded");
        replacement = new Worker<RunJob>(name, async (job) => t.engine.process(job.data), {
          connection,
          lockDuration: 500,
          stalledInterval: 500,
        });
        replacement.on("error", () => undefined);
        await vi.waitFor(
          async () => {
            expect(
              (
                await t.store
                  .scoped(t.context)
                  .videoRunStep.findFirstOrThrow({ where: { id: step.id } })
              ).state,
            ).toBe("SUCCEEDED");
          },
          { timeout: 10000, interval: 100 },
        );
        expect(submit).toHaveBeenCalledTimes(1);
        expect(
          await t.db.usageReservation.count({
            where: {
              workspaceId: t.context.workspaceId,
              idempotencyKey: `m08:${step.idempotencyKey}`,
            },
          }),
        ).toBe(1);
        const envelope = await t.store
          .scoped(t.context)
          .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } });
        expect(envelope.reservedMinor).toBe(0);
        expect(envelope.spentMinor).toBe(53);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await replacement?.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    }, 20000);
  },
);
