import { vi } from "vitest";
import { generating, type runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Run, RunJob } from "../runs/runs.types.js";
import type { MediaPlanning } from "../scene-media/media-planning.js";
import { scriptFixture } from "../script/planning.fixture.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts, seedPlayableShotReceipts } from "./media-recovery.fixture.js";
const narrator = {
  providerId: "gemini" as const,
  voiceId: "narrator",
  language: "English",
  pace: 1,
};
export async function setupAssembly(
  fixture: ReturnType<typeof runsFixture>,
  leaveFirstShotPending = false,
): Promise<{
  t: Tenant;
  run: Run;
  plan: NonNullable<Awaited<ReturnType<MediaPlanning["saved"]>>>;
  native: ReturnType<typeof fakeMediaPorts>;
  bindings: ReturnType<typeof bindMedia>;
  job: RunJob;
}> {
  const t = await fixture.tenant("L2", 30, narrator);
  await generating(t);
  const run = await t.store.get(t.context, t.run.id);
  const db = t.store.scoped(t.context);
  const shots = await seedPlayableShotReceipts(t, leaveFirstShotPending);
  await db.videoRun.updateMany({ where: { id: run.id }, data: { state: "ASSEMBLING" } });
  const plan = {
    script: scriptFixture(),
    manifest: {
      schemaVersion: "1.0" as const,
      workspaceId: run.workspaceId,
      runId: run.id,
      briefId: t.brief.id,
      briefVersion: 1,
      narratorVoice: narrator,
      prompts: [],
      shots,
    },
  };
  const native = fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    { audio: Buffer.from("audio"), clip: Buffer.from("clip"), image: Buffer.from("image") },
    [],
  );
  const bindings = bindMedia(t, native);
  vi.spyOn(bindings.planning, "saved").mockResolvedValue(plan);
  return {
    t,
    run: await t.store.get(t.context, run.id),
    plan,
    native,
    bindings,
    job: { ...t.runs.job(t.context, run.id), assembly: true },
  };
}
