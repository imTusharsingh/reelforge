import type { ReferenceResolver, VideoRoutingState } from "@reelforge/ai-providers";
import { CriticEvidence } from "../quality/critic-evidence.js";
import { CriticPipeline } from "../quality/critic.pipeline.js";
import { CriticStep } from "../quality/critic.step.js";
import { MediaProbe } from "../quality/media-probe.js";
import { RunCritic } from "../quality/run-critic.js";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "../runs/runs.types.js";
import { ModuleRef } from "@nestjs/core";
import { AssemblyManifestSchema, type PlanningPromptReceipt } from "@reelforge/contracts";
import { runsFixture, generating, type Tenant } from "../runs/runs.fixture.js";
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
import { pipelineProviders } from "./media-fixture.fixture.js";

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
  async function pipeline(
    hardCapMinor: number,
    shotCount = 6,
    primaryOutage = false,
  ): Promise<{
    t: Tenant;
    native: Awaited<ReturnType<typeof pipelineProviders>>;
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
    const native = await pipelineProviders(t, shotCount);
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
    const state: VideoRoutingState = new Map();
    if (primaryOutage)
      state.set("gemini", { failures: 3, openUntil: Date.now() + 60000, accepted: 0, calls: 3 });
    const ports = new MediaPorts(
      access,
      {
        ports: async (_context: unknown, refs: ReferenceResolver) => ({
          ...native,
          ...native.video(refs),
          assertKey: (): void => {},
        }),
        videoState: () => state,
        videoOutcome: () => async (): Promise<void> => {},
      } as unknown as ProvidersRuntime,
      jobs,
    );
    const frames = new MediaFrames(access, jobs, ports, new SpawnProcessRunner()),
      planning = new MediaPlanning(access, accounts, jobs, ports);
    const aligner = {
      alignPhrases: async (
        _path: string,
        text: string,
      ): Promise<{ text: string; start: number; end: number }[]> => [{ text, start: 0, end: 20 }],
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
    const evidence = new CriticEvidence(
      assembly,
      jobs,
      planning,
      new MediaProbe(new SpawnProcessRunner()),
    );
    new CriticStep(
      access.modules,
      () => new RunCritic(access, accounts, ports, evidence, new CriticPipeline()),
    ).onModuleInit();
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
  it("rejects three ten-second shots when the generated reference takes the plan past 353 cents", async () => {
    const { t, native } = await pipeline(353, 3);
    await expect(generating(t)).rejects.toThrow("pinned cap");
    expect(native.submitted).toHaveLength(0);
    expect(await t.db.budgetEnvelope.count({ where: { runId: t.run.id } })).toBe(0);
  }, 180000);

  it("funds three clips, assembly and one paid critic at exactly 357 cents", async () => {
    const { t, native } = await pipeline(357, 3);
    await generating(t);
    const where = { runId: t.run.id };
    const envelope = (): ReturnType<typeof t.db.budgetEnvelope.findFirstOrThrow> =>
      t.db.budgetEnvelope.findFirstOrThrow({ where });
    expect(await envelope()).toMatchObject({
      baseEstimateMinor: 357,
      reshootReserveMinor: 0,
      spentMinor: 55,
    });
    const charges = await t.db.videoRunStep.findMany({
      where: { ...where, key: { startsWith: "media:" } },
    });
    expect(charges).toHaveLength(4);
    for (const step of charges) expect(step.output).toMatchObject({ budgetAccounted: true });
    // A historical sync could already have added the unmarked text calls a second time.
    await t.db.budgetEnvelope.updateMany({ where, data: { spentMinor: 106 } });
    const shots = await t.db.videoRunStep.findMany({
      where: { ...where, key: { startsWith: "shot-" } },
      orderBy: { key: "asc" },
    });
    for (const shot of shots) await t.engine.process(t.runs.job(t.context, t.run.id, shot.id));
    expect(native.submitted).toHaveLength(3);
    expect(await envelope()).toMatchObject({ spentMinor: 277, reservedMinor: 54 });
    for (let advance = 0; advance < 3; advance++)
      await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("AWAITING_APPROVAL");
    expect(
      await t.db.videoRunStep.findMany({ where: { ...where, key: "media:text:critic:1" } }),
    ).toMatchObject([{ state: "SUCCEEDED", costMinor: 17 }]);
    const ledger = await t.db.usageReservation.aggregate({
      where: { workspaceId: t.run.workspaceId, status: "COMMITTED" },
      _sum: { committedMinor: true },
    });
    expect(ledger._sum.committedMinor).toBe(303n);
    expect(await envelope()).toMatchObject({ spentMinor: 303, reservedMinor: 54 });
  }, 180000);

  it("reprices a pre-dispatch primary outage and submits the pinned frames to xAI once", async () => {
    const { t, native } = await pipeline(800, 3, true);
    await generating(t);
    const where = { runId: t.run.id, key: "shot-0" };
    const first = await t.db.videoRunStep.findFirstOrThrow({ where });
    await t.engine.process(t.runs.job(t.context, t.run.id, first.id));
    const retry = await t.db.videoRunStep.findFirstOrThrow({ where: { ...where, attempt: 2 } });
    const job = t.runs.job(t.context, t.run.id, retry.id);
    await t.engine.process(job);
    await t.engine.process(job);
    expect(native.submitted).toMatchObject([
      {
        key: `${retry.idempotencyKey}:xai`,
        body: {
          image: { url: expect.stringContaining("data:image/") },
          reference_images: [{ url: expect.stringContaining("data:image/") }],
        },
      },
    ]);
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: retry.id } })).toMatchObject({
      state: "SUCCEEDED",
      costMinor: 142,
      output: { receiptBudget: { admittedMinor: 178, bufferMinor: 36 } },
    });
    expect(
      await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({ route: "FALLBACK", baseEstimateMinor: 629 });
  }, 180000);

  it("plans, generates six real clips, chains frames, assembles voice/music/captions and writes a complete <=$8 manifest", async () => {
    const { t, native, paid, renderer, assembly } = await pipeline(800);
    await generating(t);
    expect(
      await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({
      baseEstimateMinor: 369,
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
    native.submitted.forEach((call, index) => {
      const frame = { type: "image", mime_type: "image/png", data: expect.any(String) };
      expect(call).toMatchObject({
        key: `${steps[index]!.idempotencyKey}:gemini`,
        body: { input: [frame, frame, ...(index ? [frame] : []), { type: "text" }] },
      });
    });
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
