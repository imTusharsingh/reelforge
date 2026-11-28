import { report } from "../autonomy/autonomy.fixture.js";
import { CriticStep } from "../quality/critic.step.js";
import type { RunCritic } from "../quality/run-critic.js";
import { criticTextPort } from "../quality/critic-text-port.js";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interactions, ProviderHttp } from "@reelforge/ai-providers";
import { RunsQueue } from "../runs/runs.queue.js";
import { AssemblyManifestSchema, ShotSpecSchema } from "@reelforge/contracts";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { AssetService } from "../asset/asset.service.js";
import { fixtureMedia } from "./media-fixture.fixture.js";
import { fakeMediaPorts } from "./media-recovery.fixture.js";
import { bindMedia } from "./media-bindings.fixture.js";

const narrator = {
  providerId: "gemini" as const,
  voiceId: "fixture-voice",
  language: "English",
  pace: 1,
};
function offline(t: Tenant, outputs: unknown[] = []): ReturnType<typeof fakeMediaPorts> {
  return fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    { audio: Buffer.from("audio"), clip: Buffer.from("clip"), image: Buffer.from("image") },
    outputs,
  );
}
describe.skipIf(
  !process.env.DATABASE_URL ||
    !existsSync(process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg") ||
    !existsSync(process.env.FFPROBE_PATH ?? "/usr/bin/ffprobe"),
)("V5 real offline video assembly on fake providers", () => {
  const fixture = runsFixture();
  beforeEach(() => {
    for (const key of ["VIDEO", "IMAGE", "TEXT", "TTS", "MUSIC"])
      vi.stubEnv(`GEMINI_${key}_MODEL`, `fixture-${key}`);
    vi.stubEnv("XAI_VIDEO_MODEL", "fixture-fallback");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("plans, generates six real clips, chains frames, assembles voice/music/captions and writes a complete <=$8 manifest", async () => {
    const t = await fixture.tenant("L2", 30, narrator, false);
    const shots = shotsFixture({ ...planningFixture(), runId: t.run.id, brief: t.brief }).map(
      (shot, ordinal) => ({
        ...shot,
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        durationSeconds: 5,
        transition: ordinal === 0 ? "crossfade" : "cut",
      }),
    );
    const bytes = await fixtureMedia();
    const native = fakeMediaPorts(t.context.workspaceId, t.storage, bytes, [
      scriptFixture(),
      shots,
      {
        character: null,
        styleFrame: "Original blue leaf illustration",
        keyframePrompts: shots.map(() => "Blue leaf, portrait 9:16"),
      },
      ...Array.from({ length: 2 }, () => ({
        hook: 9,
        coherence: 9,
        artifacts: 9,
        captionSync: 9,
        briefFit: 9,
        policy: 10,
      })),
    ]);
    const original = bindMedia(t, native);
    // Stop after attaching the writer result, before writing its final receipt.
    const job = t.runs.job(t.context, t.run.id);
    await t.engine.process(job);
    vi.spyOn(original.accounts, "complete").mockRejectedValueOnce(new Error("worker stopped"));
    await expect(t.engine.process(job)).rejects.toThrow("worker stopped");
    const writer = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "media:text:scriptwriter" },
    });
    vi.stubEnv("GEMINI_TEXT_MODEL", "changed-text-model");
    bindMedia(t, native);
    await t.engine.process(job);
    await t.engine.process(job);
    const savedWriter = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: writer.id } });
    expect(savedWriter.output).toMatchObject({ result: { receipt: { modelId: "fixture-TEXT" } } });
    const steps = await t.store.scoped(t.context).videoRunStep.findMany({
      where: { runId: t.run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    const first = steps[0]!;
    const firstJob = t.runs.job(t.context, t.run.id, first.id);
    vi.spyOn(native.omni, "poll").mockResolvedValueOnce("running");
    expect(await t.engine.process(firstJob)).toBe(12000);
    const shot = ShotSpecSchema.parse(first.input);
    const [reference] = await original.access.modules
      .get(ReferenceLibraryService, { strict: false })
      .resolve(t.context, shot.references);
    const asset = await original.access.modules
      .get(AssetService, { strict: false })
      .getReference(t.context, { assetId: reference!.assetId!, version: reference!.assetVersion! });
    const object = { workspaceId: t.context.workspaceId, objectKey: asset.objectKey };
    const body = await t.storage.getObject(object);
    await t.storage.deleteObject(object);
    const { assembly, renderer, access, accounts, ports } = bindMedia(t, native);
    const render = vi.spyOn(renderer, "render");
    await expect(ports.get(t.context, shot)).rejects.toThrow();
    const admitted = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: first.id } });
    const download = vi.spyOn(native.omni, "fetch");
    const write = vi.spyOn(t.artifacts, "put");
    await t.db.videoRunStep.update({ where: { id: first.id }, data: { output: {} } });
    const http = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "video", mime_type: "video/mp4", data: "YQ==" }],
          },
        ],
      }),
    );
    const interactions = new Interactions(
      new ProviderHttp("AIza" + "abc".repeat(12), "gemini", http),
      {
        save: async (): Promise<never> => {
          throw new Error("Unexpected download");
        },
      },
    );
    vi.mocked(native.omni.poll).mockImplementation((id) => interactions.poll(id));
    await expect(t.engine.process(firstJob)).rejects.toThrow("Missing admission video pricing");
    expect(http).not.toHaveBeenCalled();
    const enqueue = vi.fn<RunsQueue["enqueue"]>().mockResolvedValue(undefined);
    t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
    for (let sweep = 0; sweep < 2; sweep++) {
      enqueue.mockClear();
      await t.engine.recover();
      expect(enqueue).not.toHaveBeenCalled();
    }
    t.runs.queue = null;
    expect(http).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect((await t.store.get(t.context, t.run.id)).pauseReason).toContain(first.id);
    await expect(t.control.resume(t.context, t.run.id)).rejects.toThrow("Reconcile");
    await t.db.videoRunStep.update({ where: { id: first.id }, data: { output: admitted.output! } });
    await expect(t.engine.process(firstJob)).resolves.toBeNull();
    expect(http).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    vi.mocked(native.omni.poll).mockRestore();
    await t.control.resume(t.context, t.run.id);
    expect((await t.store.get(t.context, t.run.id)).pauseReason).toBeNull();
    expect(native.submitted).toHaveLength(1);
    await t.storage.putObject({ ...object, body, contentType: asset.mediaType });
    vi.spyOn(native.omni, "poll").mockResolvedValueOnce("refused");
    await t.engine.process(t.runs.job(t.context, t.run.id, steps[1]!.id));
    const rewritten = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: steps[1]!.key, attempt: 2 },
    });
    await t.engine.process(t.runs.job(t.context, t.run.id, rewritten.id));
    for (const step of steps.slice(2))
      await t.engine.process(t.runs.job(t.context, t.run.id, step.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const artifacts = await assembly.artifacts(t.context, t.run);
    expect(artifacts.map((artifact) => artifact.kind)).toContain("final");
    const manifestArtifact = artifacts.find((artifact) => artifact.kind === "manifest")!;
    const manifest = AssemblyManifestSchema.parse(
      JSON.parse(
        (
          await t.storage.getObject({
            workspaceId: t.context.workspaceId,
            objectKey: manifestArtifact.objectKey,
          })
        ).toString(),
      ),
    );
    expect(manifest.durationSeconds).toBe(30);
    expect(manifest.totalCostMinor).toBeLessThanOrEqual(800);
    expect(manifest.receipts.filter((receipt) => receipt.key.startsWith("shot-"))).toHaveLength(6);
    expect(manifest.promptVersions).toHaveLength(3);
    expect(native.submitted).toHaveLength(7);
    expect(writer.input).toMatchObject({ spec: { promptVersion: manifest.promptVersions[0] } });
    expect(
      await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({ spentMinor: manifest.totalCostMinor });
    expect(manifest.totalCostMinor).toBe(
      manifest.receipts.reduce((sum, r) => sum + r.costMinor, 0) + 35,
    );
    expect(native.submitted.every((call) => !!call.options.firstFrame)).toBe(true);
    expect(native.submitted.slice(1).every((call) => !!call.options.lastFrame)).toBe(true);
    const receipts = await t.db.providerRequest.findMany({
      where: { workspaceId: t.context.workspaceId },
    });
    expect(receipts.every((row) => !row.providerId.includes("stub"))).toBe(true);
    expect(receipts.reduce((sum, row) => sum + Number(row.actualCost ?? 0), 0)).toBeLessThanOrEqual(
      8,
    );
    expect(
      (await assembly.execute(t.context, t.run, t.brief)).map(
        (artifact) => artifact.checksumSha256,
      ),
    ).toEqual(artifacts.map((artifact) => artifact.checksumSha256));
    const current = await t.store.get(t.context, t.run.id);
    const review = vi.fn(async (_context, run, _brief, _step, attempt: number) => {
      await criticTextPort({ access, accounts, ports, context: t.context, run, attempt }).complete(
        {
          prompt: "Check editing",
          jsonSchema: {},
          parse: (value) => value,
        },
        `critic:${run.id}:${attempt}`,
      );
      return {
        report,
        redo: { shots: attempt === 1 ? ["1"] : [], reedit: false },
      };
    });
    new CriticStep(
      access.modules,
      () => ({ execute: review }) as unknown as RunCritic,
    ).onModuleInit();
    await expect(t.engine.process(job)).rejects.toThrow("processes the reshoot");
    const rows = t.store.scoped(t.context).videoRunStep;
    const reshoot = await rows.findFirstOrThrow({
      where: { runId: current.id, key: "shot-1", attempt: 3 },
    });
    await t.engine.process(t.runs.job(t.context, current.id, reshoot.id));
    await t.engine.process(job);
    await t.engine.process(job);
    await t.engine.process(job);
    expect(review.mock.calls.map((call) => call[4])).toEqual([1, 2]);
    expect(await t.runs.detail(t.context, current.id)).toMatchObject({
      remainingReshoots: { "shot-1": 1, "shot-0": 2 },
    });
    expect(
      await t.db.runEvent.count({
        where: { runId: current.id, type: "critic_assembly_invalidated" },
      }),
    ).toBe(1);
    const refreshed = await assembly.artifacts(t.context, current);
    const refreshedManifest = AssemblyManifestSchema.parse(
      JSON.parse(
        (
          await t.storage.getObject({
            workspaceId: t.context.workspaceId,
            objectKey: refreshed.find((item) => item.kind === "manifest")!.objectKey,
          })
        ).toString(),
      ),
    );
    expect(refreshedManifest.promptVersions).toEqual(manifest.promptVersions);
    expect(render).toHaveBeenCalledTimes(2);
    await rows.updateMany({
      where: { runId: current.id, key: "local:assembly" },
      data: { key: "quality:assembly-history:2", idempotencyKey: "second-assembly" },
    });
    await rows.updateMany({
      where: { runId: current.id, key: "media:text:director" },
      data: { output: { result: { promptVersion: { role: "director" } } } },
    });
    await expect(assembly.execute(t.context, current, t.brief)).rejects.toThrow();
    expect(render).toHaveBeenCalledTimes(2);
  }, 180000);
  it.each(["fresh", "saved"] as const)(
    "closes SCRIPTING for a %s invalid paid script",
    async (kind) => {
      const t = await fixture.tenant("L2", 30, narrator, false);
      const invalid = { ...scriptFixture(), wordCount: 1 };
      const native = offline(t, [invalid, invalid]);
      const { accounts } = bindMedia(t, native);
      const submit = vi.spyOn(native.text, "complete");
      const job = t.runs.job(t.context, t.run.id);
      await t.engine.process(job);
      if (kind === "saved") {
        const run = await t.store.get(t.context, t.run.id);
        const step = await accounts.begin(
          t.context,
          run,
          "media:text:scriptwriter",
          {},
          17,
          "fixture-TEXT",
          true,
        );
        const result = await accounts.dispatchTextAttempt(t.context, step, (sent) =>
          native.text.completePaid!(
            {
              prompt: "write",
              jsonSchema: {},
              parse: (value) => value,
            },
            step.idempotencyKey,
            sent,
          ),
        );
        await accounts.complete(t.context, step, result);
      }
      await expect(t.engine.process(job)).rejects.toThrow("Incorrect script word count");
      await expect(t.engine.process(job)).resolves.toBeNull();
      const steps = await t.store
        .scoped(t.context)
        .videoRunStep.findMany({ where: { runId: t.run.id, state: "FAILED" } });
      expect(steps.map((step) => step.key).sort()).toEqual([
        "SCRIPTING",
        "media:text:scriptwriter",
        "media:text:scriptwriter",
        "planning:manifest:v1",
      ]);
      const writer = steps.find((step) => step.providerJobId === "fixture-text-1")!;
      expect(writer.providerJobId).toBe("fixture-text-1");
      if (kind === "saved") expect(writer.output).toMatchObject({ result: { output: invalid } });
      expect(steps.find((step) => step.key === "SCRIPTING")?.error).toMatchObject({
        message: "Incorrect script word count",
      });
      expect(await t.store.get(t.context, t.run.id)).toMatchObject({
        state: "FAILED",
        pauseReason: "SCRIPT_VALIDATION",
      });
      expect(
        await t.db.usageReservation.findMany({ where: { workspaceId: t.context.workspaceId } }),
      ).toMatchObject(Array(2).fill({ status: "COMMITTED", committedMinor: 17n }));
      expect(submit).toHaveBeenCalledTimes(2);
      expect(submit.mock.calls[1]![0].prompt).toContain("Incorrect script word count");
      expect(submit.mock.calls[0]![1]).not.toBe(submit.mock.calls[1]![1]);
    },
  );

  it("settles a schema-valid art plan with the wrong keyframe count once", async () => {
    const t = await fixture.tenant("L2", 30, narrator, false);
    const shots = shotsFixture({ ...planningFixture(), runId: t.run.id, brief: t.brief }).map(
      (shot) => ({ ...shot, workspaceId: t.context.workspaceId, durationSeconds: 5 }),
    );
    const native = offline(t, [
      scriptFixture(),
      shots,
      { character: null, styleFrame: "Leaves", keyframePrompts: shots.slice(1).map(() => "Leaf") },
    ]);
    bindMedia(t, native);
    const job = t.runs.job(t.context, t.run.id);
    const submit = vi.spyOn(native.text, "complete");
    await t.engine.process(job);
    await expect(t.engine.process(job)).rejects.toThrow("One keyframe prompt per shot required");
    bindMedia(t, native);
    await t.engine.process(job);
    expect(submit).toHaveBeenCalledTimes(3);
    expect(await t.store.get(t.context, t.run.id)).toMatchObject({
      state: "FAILED",
      pauseReason: "PROVIDER_INVALID",
    });
    expect(
      await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: t.run.id, key: "media:text:art-director" },
      }),
    ).toMatchObject({ state: "FAILED", providerJobId: "fixture-text-3" });
    expect(
      await t.db.usageReservation.count({
        where: { workspaceId: t.context.workspaceId, status: "COMMITTED" },
      }),
    ).toBe(3);
  });
  it.each([
    [29, 30],
    [30, 30],
    [45, 45],
    [46, 45],
  ] as const)(
    "checks a %is saved shot list before generation for its %is target",
    async (total, target) => {
      const t = await fixture.tenant("L2", target, narrator, false);
      const shots = shotsFixture({ ...planningFixture(), runId: t.run.id }).map((shot, index) => ({
        ...shot,
        workspaceId: t.context.workspaceId,
        durationSeconds: Math.floor(total / 6) + Number(index < total % 6),
      }));
      await t.db.shotSpec.createMany({
        data: shots.map((shot) => ({
          id: shot.id,
          workspaceId: shot.workspaceId,
          runId: t.run.id,
          ordinal: shot.ordinal,
          version: 1,
          document: shot,
        })),
      });
      const prepare = t.planning.prepare(t.context, t.run);
      const accepted = total === target;
      if (accepted) await prepare;
      else await expect(prepare).rejects.toThrow("Invalid shot list");
      expect(
        await t.store
          .scoped(t.context)
          .videoRunStep.count({ where: { runId: t.run.id, key: { startsWith: "shot-" } } }),
      ).toBe(accepted ? 6 : 0);
      expect(
        await t.db.providerRequest.count({ where: { workspaceId: t.context.workspaceId } }),
      ).toBe(0);
    },
  );
});
