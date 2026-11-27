import type { PaidTextTransport } from "@reelforge/ai-providers";
import { ForbiddenException } from "@nestjs/common";
import type { Response as ExpressResponse } from "express";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../identity/auth.guard.js";
import { WorkspaceRepository } from "../workspace/workspace.repository.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { RunsController } from "./runs.controller.js";
import { runsFixture } from "./runs.fixture.js";
import {
  accepted,
  invocation,
  putLateRejection,
  rejected401,
  runtimeFixture,
  snapshot,
  socketReset,
  timeOutRejectionFold,
} from "./text-attempt-runtime.fixture.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);
afterEach(() => vi.unstubAllEnvs());

test.each([false, true])(
  "lost arm acknowledgment cannot authorize a POST (crash before surrender: %s)",
  async (crashBeforeSurrender) => {
    const { t, accounts, step } = await runtimeFixture(fixture);
    const armed = Promise.withResolvers<void>();
    const dropAck = Promise.withResolvers<void>();
    const transport = vi.fn(accepted());
    const mutate = t.store.mutate.bind(t.store);
    const fault = vi
      .spyOn(t.store, "mutate")
      .mockImplementation(async (context, id, type, work) => {
        if (type === "text_attempt_surrendered" && crashBeforeSurrender)
          throw new Error("sender died before it could surrender");
        const result = await mutate(context, id, type, work);
        if (type === "text_attempt_armed") {
          armed.resolve();
          await dropAck.promise;
          throw new Error("arm commit acknowledgment dropped");
        }
        return result;
      });
    const result = accounts.dispatchTextAttempt(t.context, step, invocation(step, transport));
    const ignored = result.catch((error: unknown) => error);
    try {
      await Promise.race([armed.promise, result]);
      await Promise.all([
        t.engine.recover(),
        expect(t.control.abandonTerminalText(t.context, step.runId, step.id)).rejects.toThrow(
          "confirmation",
        ),
      ]);
      expect(transport).not.toHaveBeenCalled();
      dropAck.resolve();
      await expect(result).rejects.toThrow(
        crashBeforeSurrender ? "reconciliation" : "acknowledgment dropped",
      );
    } finally {
      dropAck.resolve();
      await ignored;
      fault.mockRestore();
    }
    await t.engine.recover();
    await t.engine.recover();
    const state = await snapshot(t, step);
    expect(transport).not.toHaveBeenCalled();
    expect(state.journal.map(({ kind }) => kind)).toEqual(
      crashBeforeSurrender ? ["PREPARED", "ARMED"] : ["PREPARED", "ARMED", "NOT_DISPATCHED"],
    );
    expect(state.projection).toMatchObject({
      appliedSequence: state.journal.length,
      reservedMinor: crashBeforeSurrender ? 7 : 0,
      grossMinor: 0,
      netMinor: 0,
    });
    expect(state.budget).toMatchObject({
      reservedMinor: crashBeforeSurrender ? 7 : 0,
      spentMinor: 0,
    });
    expect(state.reservations).toMatchObject([
      { status: crashBeforeSurrender ? "RESERVED" : "RELEASED", committedMinor: null },
    ]);
    if (crashBeforeSurrender) {
      await expect(t.control.abandonTerminalText(t.context, step.runId, step.id)).rejects.toThrow(
        "confirmation",
      );
      await expect(
        accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
      ).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      return;
    }
    const current = await t.store.get(t.context, step.runId);
    const retry = await accounts.begin(t.context, current, step.key, {}, 7, "fixture-text", true);
    expect(retry.attempt).toBe(step.attempt + 1);
    expect(retry.idempotencyKey).not.toBe(step.idempotencyKey);
  },
);

test("the worker replays a durable typed 401 after settlement expires without repeating the POST", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const transport = vi.fn(rejected401());
  const timeout = timeOutRejectionFold(t, step);
  try {
    await expect(
      accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
    ).rejects.toMatchObject({
      http: { status: 401, code: "UNAUTHENTICATED" },
      dispatched: false,
    });
    const before = await snapshot(t, step);
    expect(timeout.aborted()).toBeGreaterThan(0);
    expect(before.journal.map(({ kind }) => kind)).toEqual([
      "PREPARED",
      "ARMED",
      "SENT_EVIDENCE",
      "REJECTED",
      "SENDER_RETIRED",
    ]);
    expect(before.projection).toMatchObject({ appliedSequence: 3, reservedMinor: 7, netMinor: 0 });
    expect(before.reservations).toMatchObject([{ status: "RESERVED", committedMinor: null }]);
    expect(before.budget).toMatchObject({ reservedMinor: 7, spentMinor: 0 });
  } finally {
    timeout.restore();
  }
  await t.engine.recover();
  const after = await snapshot(t, step);
  await t.engine.recover();
  expect(await snapshot(t, step)).toEqual(after);
  expect(after.projection).toMatchObject({
    appliedSequence: 5,
    reservedMinor: 0,
    grossMinor: 0,
    netMinor: 0,
  });
  expect(after.reservations).toMatchObject([
    { status: "RELEASED", committedMinor: null, releaseReason: "UNAUTHENTICATED" },
  ]);
  expect(after.budget).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
  expect(transport).toHaveBeenCalledOnce();
});

test("a dropped HTTP response remains unresolved and never becomes a retryable rejection", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const transport = vi.fn(socketReset());
  await expect(
    accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
  ).rejects.toMatchObject({
    kind: "OUTAGE",
    dispatched: true,
  });
  await t.engine.recover();
  await t.engine.recover();
  const state = await snapshot(t, step);
  expect(state.journal.map(({ kind }) => kind)).toEqual([
    "PREPARED",
    "ARMED",
    "SENT_EVIDENCE",
    "SENDER_RETIRED",
  ]);
  expect(state.projection).toMatchObject({ reservedMinor: 7, netMinor: 0 });
  expect(state.reservations).toMatchObject([{ status: "RESERVED", committedMinor: null }]);
  expect(await t.store.get(t.context, step.runId)).toMatchObject({
    pauseReason: expect.stringContaining("RECONCILE_REQUIRED"),
  });
  await expect(
    accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
  ).rejects.toThrow();
  expect(transport).toHaveBeenCalledOnce();
});

test("cancel wins while the uncommitted arm loses its connection", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const transport = vi.fn(accepted());
  const inTransaction = Promise.withResolvers<void>();
  const dropConnection = Promise.withResolvers<void>();
  const cancelEntered = Promise.withResolvers<void>();
  const cancelDone = Promise.withResolvers<void>();
  const mutate = t.store.mutate.bind(t.store);
  const fault = vi.spyOn(t.store, "mutate").mockImplementation(async (context, id, type, work) => {
    if (type === "text_attempt_surrendered") await cancelDone.promise;
    if (type === "transition") cancelEntered.resolve();
    if (type !== "text_attempt_armed") return mutate(context, id, type, work);
    return mutate(context, id, type, async (...args) => {
      await work(...args);
      inTransaction.resolve();
      await dropConnection.promise;
      throw new Error("connection dropped before arm commit");
    });
  });
  const sending = accounts.dispatchTextAttempt(t.context, step, invocation(step, transport));
  const settled = sending.catch((error: unknown) => error);
  try {
    await Promise.race([inTransaction.promise, sending]);
    const cancellation = t.control
      .cancel(t.context, step.runId)
      .finally(() => cancelDone.resolve());
    await cancelEntered.promise;
    dropConnection.resolve();
    await expect(cancellation).resolves.toBe(false);
    await expect(sending).rejects.toThrow("connection dropped");
  } finally {
    dropConnection.resolve();
    cancelDone.resolve();
    await settled;
    fault.mockRestore();
  }
  const state = await snapshot(t, step);
  expect(state.journal.map(({ kind }) => kind)).toEqual(["PREPARED", "NOT_DISPATCHED"]);
  expect(state.reservations).toHaveLength(0);
  expect(state.projection).toMatchObject({ reservedMinor: 0, netMinor: 0 });
  expect(state.budget).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
  expect(transport).not.toHaveBeenCalled();
  expect(await t.store.get(t.context, step.runId)).toMatchObject({ state: "CANCELED" });
});

test("a committed arm makes cancel return 202 pending and blocks additional attempts", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const transport = vi.fn(accepted());
  const acknowledged = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const mutate = t.store.mutate.bind(t.store);
  const fault = vi.spyOn(t.store, "mutate").mockImplementation(async (context, id, type, work) => {
    const result = await mutate(context, id, type, work);
    if (type === "text_attempt_armed") {
      acknowledged.resolve();
      await resume.promise;
    }
    return result;
  });
  const sending = accounts.dispatchTextAttempt(t.context, step, invocation(step, transport));
  const settled = sending.catch((error: unknown) => error);
  try {
    await Promise.race([acknowledged.promise, sending]);
    const controller = new RunsController(
      t.runs,
      new WorkspaceService(t.db, new WorkspaceRepository(t.db)),
      t.control,
      t.artifacts,
    );
    const request = { principal: { userId: t.context.userId } } as AuthenticatedRequest;
    const status = vi.fn();
    const response = { status } as unknown as ExpressResponse;
    await expect(
      controller.cancel(request, step.runId, t.context.workspaceId, response),
    ).resolves.toEqual({ pending: true });
    expect(status).toHaveBeenCalledExactlyOnceWith(202);
    const pending = await t.store.get(t.context, step.runId);
    expect(pending).toMatchObject({ state: "SCRIPTING", pauseReason: "CANCEL_REQUESTED" });
    await expect(
      accounts.begin(t.context, pending, "media:text:director", {}, 7, "fixture-text", true),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    resume.resolve();
    await expect(sending).rejects.toThrow("Cancellation");
  } finally {
    resume.resolve();
    await settled;
    fault.mockRestore();
  }
  await t.engine.recover();
  expect(await t.store.get(t.context, step.runId)).toMatchObject({ state: "CANCELED" });
  await expect(
    accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
  ).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  const state = await snapshot(t, step);
  expect(state.journal.map(({ kind }) => kind)).toEqual(["PREPARED", "ARMED", "NOT_DISPATCHED"]);
  expect(state.reservations).toMatchObject([{ status: "RELEASED", committedMinor: null }]);
  expect(state.projection).toMatchObject({ reservedMinor: 0, netMinor: 0 });
});

test("an already-authorized sender can hand off only its original body while cancel is pending", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const enteredTransport = Promise.withResolvers<void>();
  const handoff = Promise.withResolvers<void>();
  const send = vi.fn(accepted());
  const transport = vi.fn<PaidTextTransport>(async (...args) => {
    enteredTransport.resolve();
    await handoff.promise;
    return send(...args);
  });
  const sending = accounts.dispatchTextAttempt(t.context, step, invocation(step, transport));
  const settled = sending.catch((error: unknown) => error);
  try {
    await Promise.race([enteredTransport.promise, sending]);
    await expect(t.control.cancel(t.context, step.runId)).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(await t.store.get(t.context, step.runId)).toMatchObject({
      state: "SCRIPTING",
      pauseReason: "CANCEL_REQUESTED",
    });
    handoff.resolve();
    await expect(sending).resolves.toMatchObject({
      dispatchKey: step.idempotencyKey,
      providerJobId: null,
    });
  } finally {
    handoff.resolve();
    await settled;
  }
  expect(await t.store.get(t.context, step.runId)).toMatchObject({ state: "CANCELED" });
  await t.engine.recover();
  await expect(
    accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
  ).rejects.toThrow();
  expect(transport).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
  const state = await snapshot(t, step);
  expect(state.journal.map(({ kind }) => kind)).toEqual([
    "PREPARED",
    "ARMED",
    "SENT_EVIDENCE",
    "SUCCEEDED",
    "SENDER_RETIRED",
  ]);
  expect(state.reservations).toMatchObject([{ status: "COMMITTED", committedMinor: 7n }]);
  expect(state.projection).toMatchObject({ reservedMinor: 0, netMinor: 7 });
  expect(state.budget).toMatchObject({ reservedMinor: 0, spentMinor: 7 });
});

test("a lost owner acknowledgment replays after a late 401 reverses the booking exactly once", async () => {
  const { t, accounts, step } = await runtimeFixture(fixture);
  const transport = vi.fn(socketReset());
  await expect(
    accounts.dispatchTextAttempt(t.context, step, invocation(step, transport)),
  ).rejects.toThrow();

  const mutate = t.store.mutate.bind(t.store);
  const ack = vi.spyOn(t.store, "mutate").mockImplementation(async (context, id, type, work) => {
    const result = await mutate(context, id, type, work);
    if (type === "text_owner_confirmed") throw new Error("confirmation acknowledgment dropped");
    return result;
  });
  try {
    await expect(t.control.abandonTerminalText(t.context, step.runId, step.id)).rejects.toThrow(
      "acknowledgment dropped",
    );
  } finally {
    ack.mockRestore();
  }
  expect((await snapshot(t, step)).reservations).toMatchObject([
    { status: "COMMITTED", committedMinor: 7n },
  ]);

  await putLateRejection(t, step);
  const timeout = timeOutRejectionFold(t, step);
  try {
    // Durable storage migration into the journal survives the settlement transaction failure.
    await expect(t.engine.recover()).rejects.toMatchObject({ code: "P2028" });
    const pending = await snapshot(t, step);
    expect(timeout.aborted()).toBe(1);
    expect(pending.journal.at(-1)).toMatchObject({ kind: "REJECTED" });
    expect(pending.projection).toMatchObject({ netMinor: 7, reservedMinor: 0 });
    expect(pending.reservations).toMatchObject([{ status: "COMMITTED", committedMinor: 7n }]);
    expect(pending.budget).toMatchObject({ spentMinor: 7, reservedMinor: 0 });
  } finally {
    timeout.restore();
  }
  await t.engine.recover();
  await t.engine.recover();
  const settled = await snapshot(t, step);
  await expect(
    t.control.abandonTerminalText(t.context, step.runId, step.id),
  ).resolves.toBeUndefined();
  await expect(
    t.control.abandonTerminalText({ ...t.context, role: "EDITOR" }, step.runId, step.id),
  ).rejects.toBeInstanceOf(ForbiddenException);
  const other = await fixture.tenant();
  await expect(t.control.abandonTerminalText(other.context, step.runId, step.id)).rejects.toThrow();

  expect(await snapshot(t, step)).toEqual(settled);
  expect(settled.journal.filter(({ kind }) => kind === "OWNER_CONFIRMED")).toHaveLength(1);
  expect(settled.journal.filter(({ kind }) => kind === "REJECTED")).toHaveLength(1);
  expect(settled.projection).toMatchObject({
    appliedSequence: settled.journal.length,
    reservedMinor: 0,
    grossMinor: 0,
    netMinor: 0,
  });
  expect(settled.reservations).toMatchObject([{ status: "COMMITTED", committedMinor: 0n }]);
  expect(settled.budget).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
  expect(transport).toHaveBeenCalledOnce();
});
