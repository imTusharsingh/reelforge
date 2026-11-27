import { expect, it, vi } from "vitest";
import {
  GeminiText,
  Interactions,
  InvalidCompletedText,
  ProviderHttp,
} from "@reelforge/ai-providers";
import { textFixture } from "./text-dispatch.fixture.js";
import { readAdmission } from "../usage-budget/run-admission-state.js";
import { markDispatching } from "../usage-budget/run-paid-dispatch.js";
import { finalizeFailed, finalizeInvalidText } from "../usage-budget/run-paid-failure.js";
import {
  DISPATCHING,
  OUTCOME_UNKNOWN,
  TEXT_DISPATCH_PROTOCOL,
} from "../usage-budget/run-admission-state.js";
import { recoverTextDispatches, withTextDispatch } from "../usage-budget/text-dispatch-recovery.js";
import { textReceiptReference } from "../usage-budget/text-evidence.js";
import { runsFixture } from "./runs.fixture.js";
import { json, type Step } from "./runs.types.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);
test("worker recovery fences a live dispatcher, then promotes the orphaned paid marker", async () => {
  const { t, accounts, paid, step } = await textFixture(fixture);
  const sent = vi.fn();
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const worker = withTextDispatch(step, async (check) => {
    await paid.dispatch(
      t.context,
      step,
      async () => {
        sent();
        held.resolve();
        await release.promise;
      },
      check,
    );
  });
  try {
    await held.promise;
    await recoverTextDispatches(t.store, t.context, t.usage);
    expect(
      await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } }),
    ).toMatchObject({
      errorCode: DISPATCHING,
      responseMetadata: { textDispatchProtocol: TEXT_DISPATCH_PROTOCOL },
    });
    await expect(t.control.abandonTerminalText(t.context, step.runId, step.id)).rejects.toThrow(
      "confirmation",
    );
  } finally {
    release.resolve();
    await worker;
  }
  // Simulate a crash: the session vanished without attaching or handling the response.
  await t.engine.recover();
  await recoverTextDispatches(t.store, t.context, t.usage);
  expect(
    await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } }),
  ).toMatchObject({ errorCode: OUTCOME_UNKNOWN });
  expect(await t.store.get(t.context, step.runId)).toMatchObject({
    pauseReason: expect.stringContaining("RECONCILE_REQUIRED"),
  });
  await expect(
    accounts.dispatchText(t.context, step, async () => {
      sent();
      return { providerJobId: "unexpected-second-submission" };
    }),
  ).rejects.toThrow();
  await t.control.abandonTerminalText(t.context, step.runId, step.id);
  expect(sent).toHaveBeenCalledOnce();
  expect(await t.db.usageReservation.findMany({ where: { correlationId: step.id } })).toMatchObject(
    [{ status: "COMMITTED", committedMinor: 7n }],
  );
});

test.each([null, "sync-text-advisory-v1"])(
  "never promotes an older dispatch marker (%s)",
  async (version) => {
    const { t, step } = await textFixture(fixture);
    await markDispatching(t.store, t.context, step);
    if (version)
      await t.db.providerRequest.updateMany({
        where: { correlationId: step.id },
        data: { responseMetadata: { dispatched: true, textDispatchProtocol: version } },
      });
    await recoverTextDispatches(t.store, t.context, t.usage);
    expect(
      await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } }),
    ).toMatchObject({ errorCode: DISPATCHING, responseMetadata: { dispatched: true } });
    await expect(t.control.abandonTerminalText(t.context, step.runId, step.id)).rejects.toThrow(
      "confirmation",
    );
    expect(
      await t.db.usageReservation.findMany({ where: { correlationId: step.id } }),
    ).toMatchObject([{ status: "RESERVED", committedMinor: null }]);
  },
);

test("releases the original reservation when the final pre-POST lock assertion fails", async () => {
  const { t, step, paid } = await textFixture(fixture, true);
  const check = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("lost lock"));
  const send = vi.fn();
  await expect(paid.dispatch(t.context, step, send, check)).rejects.toThrow("Ownership lost");
  await recoverTextDispatches(t.store, t.context, t.usage);
  expect(check).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();
  expect(
    await t.db.usageReservation.findMany({
      where: { idempotencyKey: `m08:${step.idempotencyKey}` },
    }),
  ).toMatchObject([{ status: "RELEASED", committedMinor: null }]);
  const row = await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } });
  expect(row).toMatchObject({
    errorCode: "NOT_DISPATCHED",
    responseMetadata: { dispatched: false, costKnown: true },
  });
  expect(row.actualCost?.isZero()).toBe(true);
  expect(await t.db.budgetEnvelope.findFirst({ where: { runId: step.runId } })).toMatchObject({
    spentMinor: 0,
    reservedMinor: 0,
  });
});

test.each([false, true])(
  "preparation never becomes confirmable across lock loss (recover first: %s)",
  async (recoverFirst) => {
    const { t, step, paid } = await textFixture(fixture, true);
    const mutate = t.store.mutate.bind(t.store);
    const send = vi.fn();
    const check = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("lost lock"));
    const spy = vi.spyOn(t.store, "mutate").mockImplementation(async (context, id, type, work) => {
      if (type === "text_dispatch_started") {
        // Preparation committed, but the sender never crossed the final fence.
        if (recoverFirst) await recoverTextDispatches(t.store, context, t.usage);
        await expect(t.control.abandonTerminalText(context, step.runId, step.id)).rejects.toThrow(
          "confirmation",
        );
        if (!recoverFirst) {
          // Roll back a cleanup transaction, then let restart clear the original preparation.
          return mutate(context, id, type, async (...args) => {
            await work(...args);
            throw new Error("cleanup transaction lost");
          });
        }
      }
      return mutate(context, id, type, work);
    });
    try {
      await expect(paid.dispatch(t.context, step, send, check)).rejects.toThrow(
        recoverFirst ? "claim changed" : "cleanup transaction lost",
      );
    } finally {
      spy.mockRestore();
    }
    await recoverTextDispatches(t.store, t.context, t.usage);
    await recoverTextDispatches(t.store, t.context, t.usage);
    expect(send).not.toHaveBeenCalled();
    expect(
      await t.db.usageReservation.findMany({
        where: { idempotencyKey: `m08:${step.idempotencyKey}` },
      }),
    ).toMatchObject([{ status: "RELEASED", committedMinor: null }]);
    expect(await t.db.budgetEnvelope.findFirst({ where: { runId: step.runId } })).toMatchObject({
      spentMinor: 0,
      reservedMinor: 0,
    });
  },
);

test("an expired reservation with fenced no-send evidence allows a fresh attempt", async () => {
  const { t, step, paid, accounts } = await textFixture(fixture, true);
  const check = vi.fn(async () => {
    await t.db.usageReservation.updateMany({
      where: { idempotencyKey: `m08:${step.idempotencyKey}` },
      data: { status: "EXPIRED", expiresAt: new Date(Date.now() - 1000) },
    });
  });
  const send = vi.fn();
  await expect(paid.dispatch(t.context, step, send, check)).rejects.toThrow("claim changed");
  expect(send).not.toHaveBeenCalled();
  const closed = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } });
  expect(closed.state).toBe("CANCELLED");
  // A historical event alone must not override the exact fenced no-send proof.
  await t.store.mutate(t.context, step.runId, "provider_dispatch", async () => ({
    value: null,
    payload: { idempotencyKey: step.idempotencyKey },
    stepId: step.id,
  }));
  expect((await readAdmission(t.db, t.context, closed)).evidence).toBe("released-nondispatch");
  const run = await t.store.get(t.context, step.runId);
  const retry = await accounts.begin(t.context, run, step.key, {}, 7, "fixture-text");
  expect(retry).toMatchObject({ attempt: step.attempt + 1 });
  expect(retry.idempotencyKey).not.toBe(step.idempotencyKey);
});

test("id-less valid Gemini output commits the budget estimate but not provider actual cost", async () => {
  const { t, accounts, step } = await textFixture(fixture);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
    Response.json({
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 3 },
      steps: [{ type: "model_output", content: [{ type: "text", text: '{"script":"fixture"}' }] }],
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
  const result = await accounts.dispatchText(t.context, step, () =>
    port.complete(
      { prompt: "Fixture", jsonSchema: {}, parse: (value) => value },
      step.idempotencyKey,
    ),
  );
  expect(result.providerJobId).toBe(step.idempotencyKey);
  expect(textReceiptReference(step, result.providerJobId)).toEqual({
    providerJobId: null,
    dispatchKey: step.idempotencyKey,
  });
  expect(
    textReceiptReference({ ...step, providerJobId: "google-recovered" }, result.providerJobId),
  ).toEqual({ providerJobId: "google-recovered", dispatchKey: step.idempotencyKey });
  await accounts.complete(t.context, step, result);
  expect(fetcher).toHaveBeenCalledOnce();
  const row = await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } });
  expect(row).toMatchObject({
    status: "SUCCEEDED",
    actualCost: null,
    usage: { input_tokens: 12, output_tokens: 3 },
    responseMetadata: {
      dispatchKey: step.idempotencyKey,
      costKnown: false,
      costBasis: "RESERVATION",
    },
  });
  expect(row.responseMetadata).not.toHaveProperty("providerJobId");
  expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
    state: "SUCCEEDED",
    providerJobId: null,
  });
  expect(await t.db.usageReservation.findMany({ where: { correlationId: step.id } })).toMatchObject(
    [{ status: "COMMITTED", committedMinor: 7n }],
  );
});

test.each([
  "owner first: valid",
  "owner first: invalid",
  "receipt first",
  "legacy local reference",
] as const)("retains late billing evidence without a second charge (%s)", async (order) => {
  const { t, accounts, step, paid } = await textFixture(fixture);
  const sent = vi.fn();
  await expect(
    accounts.dispatchText(t.context, step, async () => {
      sent();
      throw new Error("lost reply");
    }),
  ).rejects.toThrow("RECONCILE_REQUIRED");

  const remote = "google-late-interaction";
  const receipt = {
    output: { accepted: true },
    providerJobId: remote,
    usage: { input_tokens: 23 },
  };
  const close = (): Promise<void> => t.control.abandonTerminalText(t.context, step.runId, step.id);
  const attach = (): Promise<Step> => t.runs.attachJob(t.context, step, remote, json(receipt));
  const ownerFirst = order.startsWith("owner first");
  if (order === "owner first: valid") {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settle = paid.settleFailedRequest.bind(paid);
    vi.spyOn(paid, "settleFailedRequest").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await settle(...args);
    });
    const owner = finalizeFailed(
      t.store,
      paid,
      t.context,
      step,
      "OWNER_CONFIRMED_TERMINAL_TEXT",
      "Fixture owner confirmation",
      true,
    );
    await entered.promise;
    const late = attach();
    release.resolve();
    await owner;
    expect((await late).state).toBe("FAILED");
    await close();
  } else if (ownerFirst) {
    await close();
    if (order.endsWith("invalid"))
      await finalizeInvalidText(
        t.store,
        paid,
        t.context,
        step,
        new InvalidCompletedText(remote, receipt.usage),
      );
    else expect((await attach()).state).toBe("FAILED");
    await close(); // Replay must not append another step_failed.
  } else {
    if (order === "legacy local reference") {
      await t.db.videoRunStep.update({
        where: { id: step.id },
        data: {
          providerJobId: step.idempotencyKey,
          state: "WAITING_EXTERNAL",
          output: json({ ...receipt, providerJobId: step.idempotencyKey }),
        },
      });
      await t.db.providerRequest.updateMany({
        where: { correlationId: step.id },
        data: {
          responseMetadata: { providerJobId: step.idempotencyKey, dispatched: true },
        },
      });
    }
    expect((await attach()).state).toBe("WAITING_EXTERNAL");
    await expect(close()).rejects.toThrow("confirmation");
    await accounts.complete(t.context, step, receipt);
  }
  expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
    providerJobId: remote,
    state: ownerFirst ? "FAILED" : "SUCCEEDED",
  });
  expect(
    await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } }),
  ).toMatchObject({
    actualCost: null,
    usage: receipt.usage,
    responseMetadata: { dispatchKey: step.idempotencyKey, providerJobId: remote, costKnown: false },
  });
  expect(await t.db.usageReservation.findMany({ where: { correlationId: step.id } })).toMatchObject(
    [{ status: "COMMITTED", committedMinor: 7n }],
  );
  expect(await t.db.runEvent.count({ where: { stepId: step.id, type: "step_failed" } })).toBe(
    ownerFirst ? 1 : 0,
  );
  expect(
    await t.db.runEvent.count({ where: { stepId: step.id, type: "text_evidence_recorded" } }),
  ).toBe(ownerFirst ? 1 : 0);
  expect(sent).toHaveBeenCalledOnce();
});
