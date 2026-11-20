import {
  currentContext,
  createContext,
  formatTraceparent,
  runWithContext,
} from "@reelforge/observability";
import { RECOVERY_PRINCIPAL } from "./runs.types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, take, toArray, timeout } from "rxjs";
import { DelayedError, Queue, Worker } from "bullmq";
import { parseRedisConnection } from "./redis-connection.js";
import { runsFixture, generating } from "./runs.fixture.js";
import { RunsEvents } from "./runs.events.js";
import { RunsQueue, RUN_QUEUE } from "./runs.queue.js";
import type { RunJob } from "./runs.types.js";

const enabled = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
describe.skipIf(!enabled)("V3 Redis/Postgres durability and streaming", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it("replays ordered transitions including reconnect and messages committed during subscription", async () => {
    const t = await fixture.tenant();
    t.connect();
    const stream = t.runs.events!;
    const events = firstValueFrom(
      stream.stream(t.context, t.run.id, 0).pipe(take(4), toArray(), timeout(10000)),
    );
    await t.engine.process(t.runs.job(t.context, t.run.id));
    // SCRIPTING adds one stage event and one transition.
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const first = await events;
    expect(first.map((e) => e.id)).toEqual(["1", "2", "3", "4"]);
    const reconnect = firstValueFrom(
      stream.stream(t.context, t.run.id, 2).pipe(take(2), toArray(), timeout(10000)),
    );
    expect((await reconnect).map((e) => e.id)).toEqual(["3", "4"]);
    const foreign = await fixture.tenant();
    await expect(firstValueFrom(stream.stream(foreign.context, t.run.id, 0))).rejects.toThrow();
  });
  it("a restarted worker polls stored job ids and the assembly parent waits for delayed children", async () => {
    const t = await fixture.tenant();
    await generating(t);
    const connection = parseRedisConnection(process.env.REDIS_URL!);
    const queue = new RunsQueue(process.env.REDIS_URL!);
    const inspect = new Queue<RunJob>(RUN_QUEUE, { connection });
    const steps = await t.store
      .scoped(t.context)
      .videoRunStep.findMany({ where: { runId: t.run.id, key: { startsWith: "shot-" } } });
    const submit = vi.spyOn(t.generation.provider, "submit");
    const poll = vi.spyOn(t.generation.provider, "poll").mockResolvedValue("running");
    await t.engine.process(t.runs.job(t.context, t.run.id, steps[0]!.id));
    const stored = await t.store
      .scoped(t.context)
      .videoRunStep.findFirstOrThrow({ where: { id: steps[0]!.id } });
    expect(stored.providerJobId).toBeTruthy();
    expect(stored.state).toBe("WAITING_EXTERNAL");
    await queue.fanout(
      t.runs.job(t.context, t.run.id),
      steps.map((s) => s.id),
      1000,
    );
    let childPolled: (() => void) | undefined;
    const sawPoll = new Promise<void>((resolve) => {
      childPolled = resolve;
    });
    const worker = new Worker<RunJob>(
      RUN_QUEUE,
      async (job, token) => {
        if (job.data.runId !== t.run.id) return;
        const delay = await t.engine.process(job.data);
        if (delay !== null) {
          await job.moveToDelayed(Date.now() + 12000, token);
          childPolled?.();
          throw new DelayedError();
        }
      },
      { connection, concurrency: 1 },
    );
    try {
      await Promise.race([
        sawPoll,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("No poll")), 10000)),
      ]);
      expect(await (await inspect.getJob(`${t.run.id}-assemble-1000`))!.getState()).toBe(
        "waiting-children",
      );
      // Close the consumer mid-GENERATING; a new consumer/runtime must use the persisted provider id.
      await worker.close();
      poll.mockResolvedValue("succeeded");
      const before = submit.mock.calls.length;
      const replay = await t.generation.process(
        t.context,
        await t.store.get(t.context, t.run.id),
        steps[0]!.id,
      );
      expect(replay).toBeNull();
      expect(submit.mock.calls.length).toBe(before);
      expect(
        (
          await t.store
            .scoped(t.context)
            .videoRunStep.findFirstOrThrow({ where: { id: stored.id } })
        ).state,
      ).toBe("SUCCEEDED");
    } finally {
      await worker.close();
      await inspect.obliterate({ force: true });
      await Promise.all([queue.close(), inspect.close()]);
    }
  });
  it("recovers durable PLANNING rows after a lost enqueue and respects the flag", async () => {
    const t = await fixture.tenant();
    const queue = new RunsQueue(process.env.REDIS_URL!);
    const inspect = new Queue(RUN_QUEUE, {
      connection: parseRedisConnection(process.env.REDIS_URL!),
    });
    t.runs.queue = queue;
    try {
      await t.db.workspaceMembership.deleteMany({ where: { workspaceId: t.context.workspaceId } });
      await t.engine.recover();
      const queued = await inspect.getJob(`${t.run.id}-${t.run.revision}`);
      expect(queued?.data.userId).toBe(RECOVERY_PRINCIPAL);
      const parent = createContext();
      expect(runWithContext(parent, () => t.runs.job(t.context, t.run.id)).traceparent).toBe(
        formatTraceparent(parent),
      );
      let observed: string | undefined;
      t.planning.handlers = {
        ...t.planning.handlers,
        SCRIPTING: {
          execute: async (): Promise<Record<string, never>> => {
            observed = currentContext()?.traceId;
            return {};
          },
          reconcile: async (): Promise<null> => null,
        },
      };
      await t.engine.process({ ...queued?.data, traceparent: formatTraceparent(parent) });
      expect((await t.store.get(t.context, t.run.id)).state).toBe("SCRIPTING");
      await t.engine.process(
        queued?.data ? { ...queued.data, traceparent: formatTraceparent(parent) } : undefined,
      );
      expect(observed).toBe(parent.traceId);
    } finally {
      await inspect.obliterate({ force: true });
      await queue.close();
      await inspect.close();
    }
  });
  it("supports closing an unused event transport", async () => {
    const t = await fixture.tenant();
    const events = new RunsEvents(t.store, process.env.REDIS_URL!);
    await events.close();
  });
});
