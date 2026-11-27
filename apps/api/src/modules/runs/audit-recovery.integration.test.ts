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
      id: "known-interaction",
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
    providerJobId: "known-interaction",
  });
  await expect(accounts.dispatchText(t.context, step, submit)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(await t.db.providerRequest.findFirst({ where: { correlationId: step.id } })).toMatchObject(
    {
      status: "FAILED",
      errorCode: "PROVIDER_INVALID_OUTPUT",
      actualCost: null,
      usage: { input_tokens: 12 },
      responseMetadata: { providerJobId: "known-interaction", costKnown: false },
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
