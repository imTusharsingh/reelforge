import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleRef } from "@nestjs/core";
import { AssemblyManifestSchema, type PlanningPromptReceipt } from "@reelforge/contracts";
import { runsFixture, generating } from "../runs/runs.fixture.js";
import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import { RunGeneration } from "../orchestration/video-run.generation.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { RunOutputs } from "../orchestration/video-run.outputs.js";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
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
  it("plans, generates six real clips, chains frames, assembles voice/music/captions and writes a complete <=$8 manifest", async () => {
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
      { ports: async () => native } as unknown as ProvidersRuntime,
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
    await generating(t);
    const steps = await t.store.scoped(t.context).videoRunStep.findMany({
      where: { runId: t.run.id, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    for (const step of steps) await t.engine.process(t.runs.job(t.context, t.run.id, step.id));
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
  }, 180000);
});
