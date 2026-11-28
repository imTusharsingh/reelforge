import { createHash } from "node:crypto";
import type { PaidTextTransport } from "@reelforge/ai-providers";
import { afterEach, expect, it, vi } from "vitest";
import { runsFixture } from "./runs.fixture.js";
import {
  accepted,
  invocation,
  putLateRejection,
  rejected401,
  runtimeFixture,
  snapshot,
  socketReset,
} from "./text-attempt-runtime.fixture.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);
afterEach(() => vi.unstubAllEnvs());

test("Resume cannot displace an acknowledged pending cancellation", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transport: PaidTextTransport = async (...args) => {
    entered.resolve();
    await release.promise;
    return accepted()(...args);
  };
  const sent = accounts.dispatchTextAttempt(t.context, step, invocation(step, transport));
  void sent.catch(() => undefined);
  try {
    await Promise.race([entered.promise, sent]);
    expect(await t.control.cancel(t.context, step.runId)).toBe(true);
    await expect(t.control.resume(t.context, step.runId)).rejects.toThrow(
      "Cancellation is still pending",
    );
    expect(await t.store.get(t.context, step.runId)).toMatchObject({
      pauseReason: "CANCEL_REQUESTED",
    });
  } finally {
    release.resolve();
    await sent;
  }
  expect(await t.store.get(t.context, step.runId)).toMatchObject({ state: "CANCELED" });
});

test("quarantines a bad spool record but still folds the valid provider rejection", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const post = vi.fn(socketReset());
  await expect(
    accounts.dispatchTextAttempt(t.context, step, invocation(step, post)),
  ).rejects.toThrow();
  const arm = await t.db.textAttemptEvidence.findFirstOrThrow({
    where: { attemptId: step.id, kind: "ARMED" },
  });
  const active = `runs/text-evidence/${step.id}/${arm.nonce}/SUCCEEDED.json`;
  const corrupt = Buffer.from('{"kind":"SUCCEEDED","data":null}');
  const quarantine = active.replace(
    /\.json$/,
    `.quarantine-${createHash("sha256").update(corrupt).digest("hex")}.json`,
  );
  await t.artifacts.writeTextSpool(t.context, active, corrupt);
  await putLateRejection(t, step);
  await t.engine.recover();
  await t.engine.recover();
  await expect(t.artifacts.readTextSpool(t.context, active)).rejects.toThrow();
  expect(await t.artifacts.readTextSpool(t.context, quarantine)).toEqual(corrupt);
  const state = await snapshot(t, step);
  expect(state.journal.filter(({ kind }) => kind === "REJECTED")).toHaveLength(1);
  expect(state.reservations).toMatchObject([{ status: "RELEASED", committedMinor: null }]);
  expect(state.budget).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
  expect(post).toHaveBeenCalledOnce();
});

test.each(["SUCCEEDED", "REJECTED"] as const)(
  "owner cannot confirm pending %s spool delivery",
  async (kind) => {
    const { t, accounts, step } = await runtimeFixture(fixture);
    const response = kind === "SUCCEEDED" ? accepted() : rejected401();
    const transport = vi.fn<PaidTextTransport>(async (url, input, sent) => {
      const result = await response(url, input, sent);
      vi.spyOn(t.db, "$transaction").mockRejectedValueOnce(
        new Error("response ingestion unavailable"),
      );
      return result;
    });
    await expect(
      accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
    ).rejects.toThrow();
    const before = await snapshot(t, step);
    expect(before.journal.map((row) => row.kind)).toEqual(["PREPARED", "ARMED", "SENT_EVIDENCE"]);
    await expect(t.control.abandonTerminalText(t.context, step.runId, step.id)).rejects.toThrow();
    await t.engine.recover();
    await t.engine.recover();
    const settled = await snapshot(t, step);
    expect(settled.journal.map((row) => row.kind)).toEqual([
      "PREPARED",
      "ARMED",
      "SENT_EVIDENCE",
      kind,
      "SENDER_RETIRED",
    ]);
    expect(settled.budget).toMatchObject({
      spentMinor: kind === "SUCCEEDED" ? 7 : 0,
      reservedMinor: 0,
    });
    if (kind === "SUCCEEDED")
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
        state: "WAITING_EXTERNAL",
        output: { output: { draft: "fixture" } },
      });
    expect(transport).toHaveBeenCalledOnce();
  },
);

test.each([503, undefined, 403])(
  "quarantines a keyed rejection with unproven status %s",
  async (httpStatus) => {
    const { t, accounts, step } = await runtimeFixture(fixture);
    const transport = vi.fn(socketReset());
    await expect(
      accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
    ).rejects.toThrow();
    await t.control.abandonTerminalText(t.context, step.runId, step.id);
    const { journal } = await snapshot(t, step);
    const arm = journal.find((event) => event.kind === "ARMED")!;
    const key = `runs/text-evidence/${step.id}/${arm.nonce}/REJECTED.json`;
    const bytes = Buffer.from(
      JSON.stringify({
        kind: "REJECTED",
        data: {
          dispatchKey: step.idempotencyKey,
          httpStatus,
          code: "UNAUTHENTICATED",
        },
      }),
    );
    await t.artifacts.writeTextSpool(t.context, key, bytes);
    await t.engine.recover();
    expect(
      await t.artifacts.readTextSpool(
        t.context,
        key.replace(
          ".json",
          `.quarantine-${createHash("sha256").update(bytes).digest("hex")}.json`,
        ),
      ),
    ).toEqual(bytes);
    expect((await snapshot(t, step)).budget).toMatchObject({ spentMinor: 7, reservedMinor: 0 });
    expect(
      await t.db.textAttemptEvidence.count({ where: { attemptId: step.id, kind: "REJECTED" } }),
    ).toBe(0);
  },
);

test("a worker sweep between preparation and authorization leaves the live sender eligible", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  await t.engine.recover();
  const post = vi.fn(accepted());
  await expect(
    accounts.dispatchTextAttempt(t.context, step, invocation(step, post)),
  ).resolves.toMatchObject({ output: { draft: "fixture" } });
  expect(post).toHaveBeenCalledOnce();
});

test("journals a typed response while the handoff spool is still writing", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const stalled = Promise.withResolvers<void>();
  const writing = Promise.withResolvers<void>();
  const write = t.artifacts.writeTextSpool.bind(t.artifacts);
  vi.spyOn(t.artifacts, "writeTextSpool").mockImplementation(async (...args) => {
    if (args[1].endsWith("/SENT_EVIDENCE.json")) {
      writing.resolve();
      await stalled.promise;
    }
    await write(...args);
  });
  let handoff: Promise<void> | undefined;
  const transport = vi.fn<PaidTextTransport>(async (url, input, sent) => {
    vi.spyOn(t.db, "$transaction").mockRejectedValueOnce(
      new Error("handoff ingestion unavailable"),
    );
    handoff = sent();
    await writing.promise;
    return rejected401()(url, input, async () => undefined);
  });
  try {
    await expect(
      accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
    ).rejects.toMatchObject({ http: { status: 401 } });
    expect((await snapshot(t, step)).reservations).toMatchObject([{ status: "RELEASED" }]);
  } finally {
    stalled.resolve();
    await handoff;
  }
});
