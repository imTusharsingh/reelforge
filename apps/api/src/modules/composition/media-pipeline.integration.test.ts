import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "../runs/runs.types.js";
import { ModuleRef } from "@nestjs/core";
import { AssemblyManifestSchema, type PlanningPromptReceipt } from "@reelforge/contracts";
import { runsFixture, generating, type Tenant } from "../runs/runs.fixture.js";
import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import { RunGeneration } from "../orchestration/video-run.generation.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { RunOutputs } from "../orchestration/video-run.outputs.js";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { captureShotReceipt } from "../usage-budget/run-billing.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { ProvidersRuntime } from "../openai/providers.runtime.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import { PlanningCharacterService } from "../character/planning-character.service.js";
import { AssetService } from "../asset/asset.service.js";
import { MediaAccess } from "../scene-media/media-access.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPorts } from "../scene-media/media-ports.js";
import { MediaFrames } from "../scene-media/media-frames.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import { MediaBindings } from "../scene-media/media-pipeline.module.js";
import { MediaAssembly } from "./media-assembly.js";
import { MediaRenderer } from "./media-render.js";
import { SpawnProcessRunner } from "./composition.engine.js";
import { fakeMediaPorts, fixtureMedia } from "./media-fixture.fixture.js";

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
  async function pipeline(hardCapMinor: number): Promise<{
    t: Tenant;
    native: ReturnType<typeof fakeMediaPorts>;
    paid: RunPaidCalls;
    renderer: MediaRenderer;
    assembly: MediaAssembly;
  }> {
    const t = await fixture.tenant(
      "L2",
      30,
      {
        providerId: "gemini",
        voiceId: "fixture-voice",
        language: "English",
        pace: 1,
      },
      false,
    );
    const brief = {
      ...t.brief,
      id: randomUUID(),
      version: 2,
      budgetPolicy: { ...t.brief.budgetPolicy, targetMinor: 320, hardCapMinor },
    };
    await t.db.channelBrief.create({
      data: {
        id: brief.id,
        workspaceId: brief.workspaceId,
        channelId: brief.channelId,
        version: brief.version,
        document: brief,
      },
    });
    t.brief = brief;
    t.run = await t.runs.create(t.context, brief.id, randomUUID());
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
    ]);
    const paid = new RunPaidCalls(new UsageBudgetService(t.db, () => new Date()), t.store);
    const mapping = new Map<unknown, unknown>([
      [RunsService, t.runs],
      [RunPaidCalls, paid],
      [RunsArtifacts, t.artifacts],
      [
        RunsBoundary,
        new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs),
      ],
      [RunGeneration, t.generation],
      [RunPlanning, t.planning],
      [RunOutputs, t.outputs],
      [AssetService, new AssetService(t.db, t.storage)],
      [ReferenceLibraryService, new ReferenceLibraryService(t.db)],
      [PlanningReferenceAssetsService, new PlanningReferenceAssetsService(t.db, t.storage)],
      [PlanningCharacterService, new PlanningCharacterService(t.db)],
      [
        PlanningPromptService,
        {
          capture: async (
            _context: unknown,
            _channel: unknown,
            role: PlanningPromptReceipt["role"],
          ): Promise<{ prompt: string; receipt: PlanningPromptReceipt }> => ({
            prompt: `fixture ${role}`,
            receipt: {
              role,
              version: 2,
              templateVersionId: randomUUID(),
              promptSnapshotId: randomUUID(),
              configSnapshotId: randomUUID(),
              fingerprintSha256: "a".repeat(64),
            },
          }),
          format: async (): Promise<{ key: string }> => ({ key: "explainer" }),
        },
      ],
    ]);
    const access = new MediaAccess({
      get: (token: unknown): unknown => mapping.get(token),
    } as unknown as ModuleRef);
    const accounts = new MediaAccounts(access),
      jobs = new MediaJobs(access, accounts, t.storage);
    const ports = new MediaPorts(
      access,
      {
        ports: async () => ({ ...native, assertKey: (): void => {} }),
        videoState: () => new Map(),
        videoOutcome: () => async (): Promise<void> => {},
      } as unknown as ProvidersRuntime,
      jobs,
    );
    const frames = new MediaFrames(access, jobs, ports, new SpawnProcessRunner()),
      planning = new MediaPlanning(access, accounts, jobs, ports);
    const aligner = {
      align: async (
        _path: string,
        text: string,
      ): Promise<{ text: string; start: number; end: number }[]> =>
        text
          .split(/\s+/)
          .map((word, index) => ({ text: word, start: index * 0.3, end: index * 0.3 + 0.25 })),
    };
    const renderer = new MediaRenderer(t.storage, new SpawnProcessRunner(), aligner);
    const assembly = new MediaAssembly(access, jobs, ports, planning, renderer);
    const binding = new MediaBindings(access, accounts, frames, ports, jobs, planning, assembly);
    binding.onModuleInit();
    return { t, native, paid, renderer, assembly };
  }
  it("rejects a 330-cent plan before the first video submission", async () => {
    const { t, native } = await pipeline(330);
    await expect(generating(t)).rejects.toThrow("pinned cap");
    expect(native.submitted).toHaveLength(0);
    expect(
      await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: t.run.id, key: "media:text:director" },
      }),
    ).toMatchObject({ state: "FAILED" });
    expect(await t.db.budgetEnvelope.count({ where: { runId: t.run.id } })).toBe(0);
  }, 180000);
  it("plans, generates six real clips, chains frames, assembles voice/music/captions and writes a complete <=$8 manifest", async () => {
    const { t, native, paid, renderer, assembly } = await pipeline(800);
    await generating(t);
    expect(
      await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({
      baseEstimateMinor: 374,
      reshootReserveMinor: 105,
    });
    const steps = await t.store.scoped(t.context).videoRunStep.findMany({
      where: { runId: t.run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    for (const step of steps) await t.engine.process(t.runs.job(t.context, t.run.id, step.id));
    expect(native.submitted).toHaveLength(6);
    const settled = await t.db.videoRunStep.findMany({
      where: { id: { in: steps.map((step) => step.id) } },
    });
    expect(settled.map((step) => step.costMinor)).toEqual([35, 35, 35, 35, 35, 35]);
    const render = renderer.render.bind(renderer);
    const rendering = vi.spyOn(renderer, "render").mockImplementationOnce(async (input) => {
      const result = await render(input);
      const receipt = input.clips[0]!.receipt;
      const shot = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: steps[0]!.id } });
      await captureShotReceipt(t.store, paid, t.context, shot, {
        ...receipt,
        costBasis: "BILLED",
        seconds: receipt.seconds + 1,
        costMinor: receipt.costMinor + 7,
        media: null,
        providerDurationSeconds: null,
      });
      return result;
    });
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const original = await assembly.artifacts(t.context, t.run);
    const read = async (
      artifacts: Artifact[],
    ): Promise<ReturnType<typeof AssemblyManifestSchema.parse>> => {
      const descriptor = artifacts.find((a) => a.kind === "manifest")!;
      const bytes = await t.storage.getObject({
        workspaceId: t.context.workspaceId,
        objectKey: descriptor.objectKey,
      });
      expect(bytes.length).toBe(descriptor.byteSize);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(descriptor.checksumSha256);
      return AssemblyManifestSchema.parse(JSON.parse(bytes.toString()));
    };
    const before = await read(original);
    const receipt = before.receipts.find((item) => item.key === steps[0]!.key)!;
    expect(receipt.costMinor).toBe(rendering.mock.calls[0]![0].clips[0]!.receipt.costMinor + 7);
    const late = {
      ...receipt,
      costBasis: "BILLED" as const,
      costMinor: receipt.costMinor + 14,
      seconds: receipt.seconds + 2,
      media: null,
      providerDurationSeconds: null,
    };
    const shot = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: steps[0]!.id } });
    const put = vi.spyOn(t.artifacts, "put");
    await captureShotReceipt(t.store, paid, t.context, shot, late);
    await captureShotReceipt(t.store, paid, t.context, shot, late);
    const pending = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "ASSEMBLING" },
    });
    expect(t.artifacts.descriptors(pending.output).some((a) => a.kind === "manifest")).toBe(false);
    put.mockRejectedValueOnce(new Error("manifest storage offline"));
    await expect(assembly.execute(t.context, t.run, t.brief)).rejects.toThrow(
      "manifest storage offline",
    );
    const artifacts = await assembly.execute(t.context, t.run, t.brief);
    const manifest = await read(artifacts);
    const descriptor = artifacts.find((a) => a.kind === "manifest")!;
    expect(descriptor.objectKey).not.toBe(original.find((a) => a.kind === "manifest")!.objectKey);
    expect(manifest.receipts).toEqual(
      before.receipts.map((item) =>
        item === receipt
          ? { ...item, costBasis: "BILLED", costMinor: late.costMinor, seconds: late.seconds }
          : item,
      ),
    );
    expect(manifest.totalCostMinor).toBe(before.totalCostMinor + 14);
    expect(manifest.totalCostMinor).toBe(
      manifest.receipts.reduce((sum, item) => sum + item.costMinor, 0),
    );
    const request = await t.db.providerRequest.findFirstOrThrow({
      where: { workspaceId: t.context.workspaceId, correlationId: shot.id },
    });
    expect(request.actualCost?.mul(100).toNumber()).toBe(late.costMinor);
    expect(artifacts.filter((a) => a.kind !== "manifest")).toEqual(
      original.filter((a) => a.kind !== "manifest"),
    );
    expect(manifest.videoChecksumSha256).toBe(before.videoChecksumSha256);
    expect(manifest.videoChecksumSha256).toBe(
      artifacts.find((a) => a.kind === "final")!.checksumSha256,
    );
    const stage = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "ASSEMBLING" },
    });
    expect(stage.output).toMatchObject({
      storageArtifacts: artifacts,
      result: { storageArtifacts: artifacts },
    });
    expect(put.mock.calls.map(([, kind]) => kind)).toEqual(["manifest", "manifest"]);
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
    expect(rendering).toHaveBeenCalledOnce();
  }, 180000);
});
