import { randomUUID } from "node:crypto";
import { SubmissionRefused } from "@reelforge/ai-providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaPortResolver } from "../orchestration/video-run.handlers.js";
import { RoutedMediaVideo } from "../scene-media/media-video.js";
import { runsFixture } from "../runs/runs.fixture.js";
import { readManifest } from "./historical-text-receipt.fixture.js";
import { setupAssembly } from "./media-assembly.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("ID-less refusal after publication", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it("reflects an owner credit on a charged refusal after the rewrite publishes", async () => {
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
    const setup = await setupAssembly(fixture, true);
    const { t, run, bindings, plan, native } = setup;
    const resolve: MediaPortResolver = async () => ({
      primary: new RoutedMediaVideo(native.omni, bindings.jobs, t.context, run),
      fallback: new RoutedMediaVideo(native.grok, bindings.jobs, t.context, run),
    });
    t.generation.resolvePorts = resolve;
    await t.db.videoRun.update({ where: { id: run.id }, data: { state: "GENERATING" } });
    const source = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "shot-0" },
    });
    const generate = async (stepId: string): Promise<void> => {
      await t.generation.process(t.context, await t.store.get(t.context, run.id), stepId);
    };
    const submit = vi
      .spyOn(native.omni, "submit")
      .mockRejectedValueOnce(new SubmissionRefused(null));
    await generate(source.id);
    const refused = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } });
    expect(refused).toMatchObject({ state: "SKIPPED", providerJobId: null });
    expect(refused.costMinor).toBeGreaterThan(3);
    const rewrite = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: source.key, attempt: 2 },
    });
    await generate(rewrite.id);
    const completed = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: rewrite.id } });
    expect(completed.state).toBe("SUCCEEDED");
    expect(submit).toHaveBeenCalledTimes(2);
    await t.db.videoRun.update({ where: { id: run.id }, data: { state: "ASSEMBLING" } });
    await t.db.videoRunStep.create({
      data: {
        workspaceId: run.workspaceId,
        runId: run.id,
        key: "ASSEMBLING",
        attempt: 1,
        state: "RUNNING",
        idempotencyKey: `${run.id}:ASSEMBLING:1`,
        input: {},
      },
    });
    vi.mocked(bindings.planning.saved).mockResolvedValue({
      ...plan,
      manifest: {
        ...plan.manifest,
        prompts: [
          {
            role: "scriptwriter",
            version: 2,
            templateVersionId: randomUUID(),
            promptSnapshotId: randomUUID(),
            configSnapshotId: randomUUID(),
            fingerprintSha256: "a".repeat(64),
          },
        ],
      },
    });
    const render = vi.spyOn(bindings.renderer, "render").mockResolvedValue({
      video: Buffer.from("fixture-final"),
      cover: Buffer.from("cover"),
      words: [{ text: "fixture", start: 0, end: 1 }],
      highlights: [],
      cues: [],
      duration: 30,
    });
    const published = await bindings.assembly.execute(t.context, run, t.brief);
    const original = await readManifest(setup, published);
    const charge = await t.db.providerRequest.findFirstOrThrow({
      where: { workspaceId: run.workspaceId, correlationId: source.id },
    });
    const credit = {
      kind: "CREDIT",
      amountMinor: 3,
      providerRequestId: charge.id,
      operationKey: "credit-idless-refusal",
      reason: "fixture refund",
    } as const;
    await t.usage.createAdjustment(t.context, credit);
    await t.usage.createAdjustment(t.context, credit);
    const refreshed = await bindings.assembly.artifacts(t.context, run);
    expect(await readManifest(setup, refreshed)).toEqual({
      ...original,
      totalCostMinor: original.totalCostMinor - 3,
    });
    expect(refreshed.find((a) => a.kind === "final")).toEqual(
      published.find((a) => a.kind === "final"),
    );
    expect(render).toHaveBeenCalledOnce();
  });
});
