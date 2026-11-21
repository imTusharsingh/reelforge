import { criticTextPort } from "../quality/critic-text-port.js";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssemblyManifestSchema, ShotSpecSchema } from "@reelforge/contracts";
import { runsFixture, generating, type Tenant } from "../runs/runs.fixture.js";
import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { AssetService } from "../asset/asset.service.js";
import { fakeMediaPorts, fixtureMedia } from "./media-fixture.fixture.js";
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
      { verdict: "reedit" },
    ]);
    const original = bindMedia(t, native);
    await generating(t);
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
    await expect(t.engine.process(firstJob)).resolves.toBeNull();
    expect(native.submitted).toHaveLength(1);
    await t.storage.putObject({ ...object, body, contentType: asset.mediaType });
    for (const step of steps.slice(1))
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
    expect(native.submitted).toHaveLength(6);
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
    await criticTextPort({
      access,
      accounts,
      ports,
      context: t.context,
      run: current,
      attempt: 1,
    }).complete(
      {
        prompt: "Check editing",
        jsonSchema: {},
        parse: (value) => value,
      },
      "critic-fixture",
    );
    await t.control.reedit(t.context, current.id);
    const rows = t.store.scoped(t.context).videoRunStep;
    await rows.updateMany({
      where: { runId: current.id, key: "local:assembly" },
      data: { key: "quality:assembly-history:1", idempotencyKey: "previous-assembly" },
    });
    await t.planning.reedit(t.context, current);
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
  it.each(["fresh", "legacy"] as const)(
    "closes SCRIPTING for a %s invalid paid script",
    async (kind) => {
      const t = await fixture.tenant("L2", 30, narrator, false);
      const invalid = { ...scriptFixture(), wordCount: 1 };
      const native = offline(t, [invalid]);
      const { accounts } = bindMedia(t, native);
      const submit = vi.spyOn(native.text, "complete");
      const job = t.runs.job(t.context, t.run.id);
      await t.engine.process(job);
      if (kind === "legacy") {
        const run = await t.store.get(t.context, t.run.id);
        const step = await accounts.begin(
          t.context,
          run,
          "media:text:scriptwriter",
          {},
          17,
          "fixture-TEXT",
        );
        await accounts.prepare(t.context, run, step, "fixture-TEXT");
        const result = await accounts.dispatchText(t.context, step, () =>
          native.text.complete(
            {
              prompt: "write",
              jsonSchema: {},
              parse: (value) => value,
            },
            step.idempotencyKey,
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
        "planning:manifest:v1",
      ]);
      const writer = steps.find((step) => step.key === "media:text:scriptwriter")!;
      expect(writer.providerJobId).toBe("fixture-text-1");
      expect(writer.output).toMatchObject(
        kind === "legacy" ? { result: { output: invalid } } : { output: invalid },
      );
      expect(await t.store.get(t.context, t.run.id)).toMatchObject({
        state: "FAILED",
        pauseReason: "PROVIDER_INVALID",
      });
      expect(
        await t.db.usageReservation.findMany({ where: { workspaceId: t.context.workspaceId } }),
      ).toMatchObject([{ status: "COMMITTED", committedMinor: 17n }]);
      expect(submit).toHaveBeenCalledOnce();
    },
  );

  it.each(["narration", "music"] as const)(
    "drains the accepted sibling when %s fails",
    async (failed) => {
      const t = await fixture.tenant("L2", 30, narrator);
      await generating(t);
      const run = await t.store.get(t.context, t.run.id);
      await t.store
        .scoped(t.context)
        .videoRun.updateMany({ where: { id: run.id }, data: { state: "ASSEMBLING" } });
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
          shots: shotsFixture(planningFixture()).map((shot) => ({ ...shot, durationSeconds: 5 })),
        },
      };
      const native = offline(t);
      vi.spyOn(bindMedia(t, native).planning, "saved").mockResolvedValue(plan);
      const bad = failed === "music" ? native.music : native.tts;
      const sibling = failed === "music" ? native.tts : native.music;
      const badSubmit = vi.spyOn(bad, "submit");
      const siblingSubmit = vi.spyOn(sibling, "submit");
      vi.spyOn(bad, "poll").mockResolvedValueOnce("running").mockResolvedValue("failed");
      vi.spyOn(sibling, "poll")
        .mockResolvedValueOnce("running")
        .mockResolvedValueOnce("running")
        .mockResolvedValue("succeeded");
      const collect = vi.spyOn(sibling, "fetch");
      const job = t.runs.job(t.context, t.run.id);
      expect(await t.engine.process(job)).toBe(12000);
      expect(await t.engine.process(job)).toBe(12000);
      const rows = t.store.scoped(t.context).videoRunStep;
      expect(await rows.findFirst({ where: { runId: run.id, key: "ASSEMBLING" } })).toMatchObject({
        state: "FAILED",
      });
      expect((await t.store.get(t.context, run.id)).state).toBe("ASSEMBLING");
      vi.spyOn(bindMedia(t, native).planning, "saved").mockResolvedValue(plan);
      await expect(t.engine.process(job)).resolves.toBeNull();
      await expect(t.engine.process(job)).resolves.toBeNull();
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: "FAILED",
        pauseReason: "PROVIDER_FAILED",
      });
      expect(
        await t.db.usageReservation.findMany({ where: { workspaceId: t.context.workspaceId } }),
      ).toMatchObject([{ status: "COMMITTED" }, { status: "COMMITTED" }]);
      expect(
        await t.store.scoped(t.context).budgetEnvelope.findFirst({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: 0, spentMinor: 9 });
      expect(badSubmit).toHaveBeenCalledOnce();
      expect(siblingSubmit).toHaveBeenCalledOnce();
      expect(collect).toHaveBeenCalledOnce();
    },
  );

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
