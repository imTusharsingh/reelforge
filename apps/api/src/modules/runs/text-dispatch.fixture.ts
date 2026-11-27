import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import type { runsFixture } from "./runs.fixture.js";
import type { Step } from "./runs.types.js";

export async function textFixture(
  fixture: ReturnType<typeof runsFixture>,
  withEnvelope = false,
): Promise<{
  t: Awaited<ReturnType<typeof fixture.tenant>>;
  accounts: ReturnType<typeof bindMedia>["accounts"];
  paid: ReturnType<typeof bindMedia>["access"]["paid"];
  step: Step;
}> {
  const t = await fixture.tenant();
  await t.engine.process(t.runs.job(t.context, t.run.id));
  const run = await t.store.get(t.context, t.run.id);
  if (withEnvelope) {
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
  }
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
