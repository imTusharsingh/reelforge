import { createHash } from "node:crypto";
import type { PaidTextTransport } from "@reelforge/ai-providers";
import { afterEach, expect, it, vi } from "vitest";
import { runsFixture } from "./runs.fixture.js";
import {
  accepted,
  invocation,
  putLateRejection,
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
