import { expect, it, vi } from "vitest";
import {
  GeminiText,
  Interactions,
  InvalidCompletedText,
  ProviderHttp,
} from "@reelforge/ai-providers";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { markDispatching } from "../usage-budget/run-paid-dispatch.js";
import { finalizeFailed, finalizeInvalidText } from "../usage-budget/run-paid-failure.js";
import { DISPATCHING, OUTCOME_UNKNOWN } from "../usage-budget/run-admission-state.js";
import { recoverTextDispatches, withTextDispatch } from "../usage-budget/text-dispatch-recovery.js";
import { runsFixture } from "./runs.fixture.js";
import { json, type Step } from "./runs.types.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);

async function textFixture(): Promise<{
  t: Awaited<ReturnType<typeof fixture.tenant>>;
  accounts: ReturnType<typeof bindMedia>["accounts"];
  paid: ReturnType<typeof bindMedia>["access"]["paid"];
  step: Step;
}> {
  const t = await fixture.tenant();
  await t.engine.process(t.runs.job(t.context, t.run.id));
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
  const { accounts, access } = bindMedia(t, native);
  const step = await accounts.begin(
    t.context,
    run,
    "media:text:scriptwriter",
    {},
    7,
    "fixture-text",
  );
  await accounts.prepare(t.context, run, step, "fixture-text");
  return { t, accounts, step, paid: access.paid };
}

test("worker recovery fences a live dispatcher, then promotes the orphaned paid marker", async () => {
  const { t, accounts, step } = await textFixture();
  const sent = vi.fn();
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const worker = withTextDispatch(step, async (check) => {
    await markDispatching(t.store, t.context, step, check);
    sent();
    held.resolve();
    await release.promise;
  });
  try {
    await held.promise;
    await recoverTextDispatches(t.store, t.context);
    expect(
      await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } }),
    ).toMatchObject({ errorCode: DISPATCHING });
    await expect(t.control.abandonTerminalText(t.context, step.runId, step.id)).rejects.toThrow(
      "confirmation",
    );
  } finally {
    release.resolve();
    await worker;
  }
  // Simulate a crash: the session vanished without attaching or handling the response.
  await t.engine.recover();
  await recoverTextDispatches(t.store, t.context);
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

test("id-less valid Gemini output commits the budget estimate but not provider actual cost", async () => {
  const { t, accounts, step } = await textFixture();
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
  const { t, accounts, step, paid } = await textFixture();
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
