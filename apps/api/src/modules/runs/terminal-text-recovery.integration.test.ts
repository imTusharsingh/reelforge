import { expect, it, vi } from "vitest";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { runsFixture } from "./runs.fixture.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);

test("settles an attached text receipt on a canceled run after restart without another POST", async () => {
  const t = await fixture.tenant();
  await t.engine.process(t.runs.job(t.context, t.run.id));
  const run = await t.store.get(t.context, t.run.id);
  const native = fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    { clip: Buffer.alloc(0), image: Buffer.alloc(0), audio: Buffer.alloc(0) },
    [],
  );
  const { accounts } = bindMedia(t, native);
  await t.db.budgetEnvelope.create({
    data: {
      workspaceId: t.context.workspaceId,
      runId: run.id,
      currency: "USD",
      baseEstimateMinor: 200,
      reshootReserveMinor: 100,
      hardCapMinor: 800,
      route: "PRIMARY",
    },
  });
  const step = await accounts.begin(
    t.context,
    run,
    "media:text:scriptwriter",
    {},
    7,
    "fixture-text",
    true,
  );
  const response = {
    output: { draft: "persisted output" },
    providerJobId: null,
    dispatchKey: step.idempotencyKey,
    usage: { input_tokens: 12, output_tokens: 3 },
  };
  const handed = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<typeof response>();
  const post = vi.fn(async (sent: () => Promise<void>) => {
    await sent();
    handed.resolve();
    return reply.promise;
  });
  const original = accounts.dispatchTextAttempt(t.context, step, post);
  await handed.promise;
  expect(await t.control.cancel(t.context, run.id)).toBe(false);
  expect(await t.store.get(t.context, run.id)).toMatchObject({ state: "CANCELED" });
  expect(await t.db.usageReservation.findMany({ where: { correlationId: step.id } })).toMatchObject(
    [{ status: "RESERVED", committedMinor: null }],
  );
  reply.resolve(response);
  await original;
  // Rebind runtime dependencies to represent the new worker, and refuse any provider text call.
  const secondPost = vi.fn().mockRejectedValue(new Error("recovery must not POST"));
  bindMedia(t, { ...native, text: { complete: secondPost } });
  await t.engine.recover();
  await t.engine.recover();

  expect(post).toHaveBeenCalledOnce();
  expect(secondPost).not.toHaveBeenCalled();
  expect(await t.store.get(t.context, run.id)).toMatchObject({ state: "CANCELED" });
  expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
    state: "WAITING_EXTERNAL",
    output: response,
  });
  expect(await t.db.providerRequest.findMany({ where: { correlationId: step.id } })).toMatchObject([
    {
      status: "SUCCEEDED",
      actualCost: null,
      usage: response.usage,
      responseMetadata: { costKnown: false },
    },
  ]);
  expect(await t.db.usageReservation.findMany({ where: { correlationId: step.id } })).toMatchObject(
    [{ status: "COMMITTED", committedMinor: 7n }],
  );
  expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
    reservedMinor: 0,
    spentMinor: 7,
  });
  expect(
    await t.db.textAttemptEvidence.count({ where: { attemptId: step.id, kind: "SUCCEEDED" } }),
  ).toBe(1);
});
