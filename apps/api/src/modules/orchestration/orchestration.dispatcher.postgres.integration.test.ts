import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import {
  IMAGE_PROVIDER,
  PROVIDER_REGISTRY,
  ProviderRegistry,
  SCRIPT_LLM,
  TTS_PROVIDER,
  VIDEO_PROVIDER,
} from "@reelforge/ai-providers";
import type {
  CapabilityMetadata,
  ImageProviderPort,
  MediaGenerationResponse,
  TtsProviderPort,
  VideoProviderPort,
} from "@reelforge/ai-providers";
import { compilePrompt, parsePromptTemplateBody, platformDefaults } from "@reelforge/config-engine";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import { STORAGE_PORT } from "../asset/storage/storage.port.js";
import type { CompositionEnginePort, RenderedArtifact } from "../composition/composition.engine.js";
import { COMPOSITION_ENGINE } from "../composition/composition.types.js";
import { COMPOSITION_CLOCK, CompositionService } from "../composition/composition.service.js";
import type { RenderCompositionInput } from "../composition/composition.types.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { PublishingService } from "../publishing/publishing.service.js";
import { QualityService } from "../quality/quality.service.js";
import { providerEnvironment } from "../scene-media/scene-media.validation.js";
import type { ScriptLlmPort } from "../script/script.types.js";
import { ScriptService } from "../script/script.service.js";
import { OrchestrationModule } from "./orchestration.module.js";
import { InMemoryWorkflowQueue } from "./orchestration.queue.js";
import { OrchestrationService } from "./orchestration.service.js";
import { ORCHESTRATION_CLOCK, WORKFLOW_QUEUE_PORT } from "./orchestration.types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ownerId = randomUUID();
const workspaceId = randomUUID();
const channelId = randomUUID();
const genreId = randomUUID();
const ideaId = randomUUID();
const snapshotId = randomUUID();
const configSnapshotId = randomUUID();
const promptSnapshotId = randomUUID();
const templateId = randomUUID();
const templateVersionId = randomUUID();
const socialAccountId = randomUUID();
const context: WorkspaceContext = { workspaceId, userId: ownerId, role: "OWNER" };

const document = {
  schemaVersion: "1.0" as const,
  title: "M16 workflow",
  hook: "Hook",
  dialogue: "Dialogue",
  cta: "CTA",
  metadata: { genre: "M16 genre", targetDurationSeconds: 1, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 1,
      characterRefs: [],
      dialogue: "D",
      visualDescription: "First frame",
      camera: "wide",
      audioCues: [],
    },
  ],
};

function capability(kind: CapabilityMetadata["kind"], capabilityId: string): CapabilityMetadata {
  return {
    providerId: "fixture",
    capabilityId,
    kind,
    input: ["text"],
    output: kind === "llm" ? ["json"] : [kind],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: 1 },
  };
}

const metadata = {
  modelVersion: "fixture-model",
  promptVersion: "fixture-prompt",
  cost: 1,
  currency: "USD",
};
const llm: ScriptLlmPort = {
  capability: capability("llm", "llm"),
  complete: async () => ({ output: document, metadata }),
};
let imageCalls = 0;
const image: ImageProviderPort = {
  capability: capability("image", "image"),
  generate: async (request): Promise<MediaGenerationResponse> => {
    imageCalls += 1;
    return {
      mediaId: `img-${request.correlationId}`,
      providerJobId: `job-${request.correlationId}`,
      providerRequestId: `req-${request.correlationId}`,
      media: { declaredMediaType: "image/png", body: PNG },
      metadata,
    };
  },
};
const video: VideoProviderPort = {
  capability: capability("image", "video"),
  generate: async () => {
    throw new Error("video is not requested by this workflow");
  },
};
const tts: TtsProviderPort = {
  capability: capability("tts", "tts"),
  synthesize: async () => {
    throw new Error("tts is not requested by this workflow");
  },
};

/** Fake FFmpeg engine: deterministic artifacts with a manifest pinned to the render input. */
function validArtifacts(input: RenderCompositionInput, jobId: string): readonly RenderedArtifact[] {
  const videoBody = Buffer.from(`m16 fixture video ${jobId}`);
  const manifest = {
    schemaVersion: "1.0",
    jobId,
    title: input.title,
    renderSeed: input.renderSeed,
    renderProfile: input.profile,
    sourceMediaPackage: input.sourceMediaPackage,
    pinnedInputs: { scenes: input.scenes, audio: input.audio, coverFrames: input.coverFrames },
    video: {
      filename: "final.mp4",
      mediaType: "video/mp4",
      byteSize: videoBody.length,
      checksumSha256: createHash("sha256").update(videoBody).digest("hex"),
      durationMs: 1000,
    },
    artifactOrder: ["VIDEO", ...input.coverFrames.map(() => "COVER"), "MANIFEST"],
  };
  return [
    {
      kind: "VIDEO",
      body: videoBody,
      mediaType: "video/mp4",
      filename: "final.mp4",
      durationMs: 1000,
    },
    ...input.coverFrames.map((selectedFrame, index) => ({
      kind: "COVER" as const,
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9, index]),
      mediaType: "image/jpeg",
      filename: `cover-${index + 1}.jpg`,
      durationMs: null,
      selectedFrame,
    })),
    {
      kind: "MANIFEST",
      body: Buffer.from(JSON.stringify(manifest)),
      mediaType: "application/json",
      filename: "manifest.json",
      durationMs: null,
    },
  ];
}

let renderCalls = 0;
const engine: CompositionEnginePort = {
  execute: async (_context, jobId, input) => {
    renderCalls += 1;
    return validArtifacts(input, jobId);
  },
};

suite("M16 workflow through the real WorkflowDomainDispatcher on PostgreSQL", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const storageRoot = join(tmpdir(), `reelforge-m16-dispatcher-${workspaceId}`);
  const queue = new InMemoryWorkflowQueue();
  let clockMs = Date.now();
  // Offsets the M10 composition clock: while negative, the inline render claim is not due yet,
  // like a render that the M10 worker has not picked up, so the step must wait for it.
  let compositionOffsetMs = -60 * 60 * 1000;
  let module: TestingModule | undefined;

  async function drain(service: OrchestrationService): Promise<string[]> {
    const statuses: string[] = [];
    for (let round = 0; round < 30; round += 1) {
      const jobs = queue.take();
      if (jobs.length === 0) break;
      clockMs += 61_000;
      for (const job of jobs) statuses.push((await service.processJob(job, "b6-worker")).status);
    }
    return statuses;
  }

  beforeAll(async () => {
    if (!db) return;
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@m16.dispatcher.invalid` } });
    await db.workspace.create({ data: { id: workspaceId, name: "m16-dispatcher" } });
    await db.workspaceMembership.create({ data: { workspaceId, userId: ownerId, role: "OWNER" } });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "m16-dispatcher" } });
    await db.genre.create({
      data: {
        id: genreId,
        workspaceId,
        name: "M16 genre",
        audience: "all",
        tone: "plain",
        topicsAllowed: [],
        topicsBlocked: [],
        language: "en",
        structure: {},
        durationPreference: {},
        safetyProfile: { requiresSourceBackedClaims: false },
      },
    });
    await db.idea.create({
      data: {
        id: ideaId,
        workspaceId,
        channelId,
        origin: "USER",
        status: "APPROVED",
        title: "Approved",
        normalizedTitle: "approved",
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        approvedAt: new Date(),
        createdByUserId: ownerId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        ideaId,
        channelId,
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        checksumSha256: "checksum",
      },
    });
    const body = parsePromptTemplateBody({
      sections: { instructions: "Write a structured script for {{topic}}." },
      variables: [{ name: "topic", required: true }],
      allowedAdditionSections: ["instructions"],
    });
    const bundle = compilePrompt({
      config: platformDefaults,
      template: {
        templateId,
        templateKey: "m16-script",
        templateName: "M16 script",
        versionId: templateVersionId,
        version: 1,
        checksumSha256: "a".repeat(64),
        body,
      },
      variables: { topic: "approved topic" },
    });
    await db.promptTemplate.create({
      data: { id: templateId, workspaceId, key: "m16-script", name: "M16 script" },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: templateVersionId,
        workspaceId,
        templateId,
        version: 1,
        status: "PUBLISHED",
        body,
        checksumSha256: "a".repeat(64),
      },
    });
    await db.configSnapshot.create({
      data: {
        id: configSnapshotId,
        workspaceId,
        version: 1,
        config: platformDefaults,
        fingerprintSha256: "b".repeat(64),
        resolutionSha256: "c".repeat(64),
        layers: [],
        lockedFields: [],
      },
    });
    await db.promptBundleSnapshot.create({
      data: {
        id: promptSnapshotId,
        workspaceId,
        version: 1,
        configSnapshotId,
        templateId,
        templateVersionId,
        bundle,
        fingerprintSha256: bundle.fingerprintSha256,
      },
    });
    await db.providerBudget.create({
      data: { workspaceId, channelId, dailyLimit: 100, currency: "USD" },
    });
    await db.socialAccount.create({
      data: {
        id: socialAccountId,
        workspaceId,
        channelId,
        platform: "YOUTUBE",
        remoteAccountId: `m16-${socialAccountId}`,
        displayName: "M16 fixture account",
      },
    });
    const registry = new ProviderRegistry();
    for (const port of [llm, image, video, tts])
      registry.register({
        capability: port.capability,
        credential: {
          providerId: "fixture",
          // Script generation still resolves its provider environment as development unless
          // production, while scene media resolves the current test environment.
          environment: port === llm ? "development" : providerEnvironment(),
          secret: "fixture-secret",
        },
      });
    module = await Test.createTestingModule({ imports: [OrchestrationModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(SCRIPT_LLM)
      .useValue(llm)
      .overrideProvider(PROVIDER_REGISTRY)
      .useValue(registry)
      .overrideProvider(IMAGE_PROVIDER)
      .useValue(image)
      .overrideProvider(VIDEO_PROVIDER)
      .useValue(video)
      .overrideProvider(TTS_PROVIDER)
      .useValue(tts)
      .overrideProvider(STORAGE_PORT)
      .useValue(new LocalFilesystemStorageAdapter(storageRoot))
      .overrideProvider(COMPOSITION_ENGINE)
      .useValue(engine)
      .overrideProvider(COMPOSITION_CLOCK)
      .useValue({ now: (): Date => new Date(Date.now() + compositionOffsetMs) })
      .overrideProvider(WORKFLOW_QUEUE_PORT)
      .useValue(queue)
      .overrideProvider(ORCHESTRATION_CLOCK)
      .useValue((): Date => new Date(clockMs))
      .compile();
  });

  afterAll(async () => {
    await module?.close();
    if (!db) return;
    const dependents = [
      "publishAttempt",
      "publishJob",
      "publishingDestination",
      "scheduledPost",
      "qualityReviewRun",
      "renderArtifact",
      "renderJob",
      "sceneGenerationOutput",
      "sceneGeneration",
      "sceneMediaJob",
      "assetUsageReference",
      "asset",
      "providerBudgetReservation",
      "providerRequest",
      "scriptRevision",
      "script",
    ];
    const delegates = db as unknown as Record<
      string,
      { deleteMany?: (args: unknown) => Promise<unknown> } | undefined
    >;
    for (const name of dependents)
      await delegates[name]?.deleteMany?.({ where: { workspaceId } }).catch(() => undefined);
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("runs idea -> script -> media -> render -> QA approval wait -> resume with the real dispatcher, and M13 refuses an unapproved publish", async () => {
    if (!db || !module) return;
    const orchestration = module.get(OrchestrationService);
    const scripts = module.get(ScriptService);
    const composition = module.get(CompositionService);
    const quality = module.get(QualityService);
    const publishing = module.get(PublishingService);

    const started = await orchestration.startManualRun(context, {
      definitionKey: "GENERATION",
      channelId,
      ideaId,
      configSnapshotId,
      promptSnapshotId,
      outputs: { image: true },
    });
    expect(started.dispatchStatus).toBe("DISPATCHED");

    // VERIFY_CONTEXT -> SELECT_IDEA -> GENERATE_SCRIPT, which waits for the M07 script approval.
    await drain(orchestration);
    let run = await orchestration.getRun(context, started.id);
    const scriptStep = run.steps.find((step) => step.stepKey === "GENERATE_SCRIPT");
    expect(run.state).toBe("RUNNING");
    expect(scriptStep).toMatchObject({ status: "WAITING_EXTERNAL", attempts: 1 });
    const scriptId = run.input["scriptId"];
    expect(typeof scriptId).toBe("string");
    expect(run.input["approvedIdeaSnapshotId"]).toBe(snapshotId);
    // The wait re-checks the existing script; it never generates a second one.
    clockMs += 61_000;
    await drain(orchestration);
    expect(await db.script.count({ where: { workspaceId } })).toBe(1);
    const observedScript = await db.script.findUniqueOrThrow({ where: { id: String(scriptId) } });
    await scripts.approve(context, String(scriptId), observedScript.currentRevision);

    // Approved script -> real scene media (fixture image provider) -> render queued (external wait).
    clockMs += 61_000;
    await drain(orchestration);
    run = await orchestration.getRun(context, started.id);
    const mediaStep = run.steps.find((step) => step.stepKey === "GENERATE_SCENE_MEDIA");
    const renderStep = run.steps.find((step) => step.stepKey === "COMPOSE_RENDER");
    expect(mediaStep).toMatchObject({ status: "SUCCEEDED", resultType: "SCENE_MEDIA_PACKAGE" });
    expect(imageCalls).toBe(1);
    expect(renderStep).toMatchObject({ status: "WAITING_EXTERNAL", attempts: 1 });
    const renderJobId = String(run.input["renderJobId"]);
    // renderJobId and sceneMediaJobId are persisted on the run as soon as they exist.
    expect(run.input["sceneMediaJobId"]).toBe(mediaStep?.resultRef);
    expect(renderJobId).toBe(renderStep?.resultRef);
    expect((await composition.get(context, renderJobId)).status).toBe("QUEUED");
    expect(run.nextAction).toContain("render queued");

    // A poll while the render is still queued keeps waiting without spending an attempt.
    clockMs += 61_000;
    await drain(orchestration);
    expect(
      (await orchestration.getRun(context, started.id)).steps.find(
        (step) => step.stepKey === "COMPOSE_RENDER",
      ),
    ).toMatchObject({ status: "WAITING_EXTERNAL", attempts: 1 });
    // The M10 poller renders it (fake engine); the next workflow poll observes SUCCEEDED.
    compositionOffsetMs = 0;
    await composition.runClaim(renderJobId);
    expect((await composition.get(context, renderJobId)).status).toBe("SUCCEEDED");
    clockMs += 61_000;
    await drain(orchestration);
    run = await orchestration.getRun(context, started.id);
    expect(run.steps.find((step) => step.stepKey === "COMPOSE_RENDER")).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
    });
    expect(renderCalls).toBe(1);

    // M11 with no AI review provider -> human approval required -> WAITING_APPROVAL.
    expect(run.state).toBe("WAITING_APPROVAL");
    const reviewStep = run.steps.find((step) => step.stepKey === "QUALITY_REVIEW");
    expect(reviewStep?.status).toBe("WAITING_APPROVAL");
    const reviewId = String(reviewStep?.resultRef);
    const review = await quality.get(context, reviewId);
    expect(["AI_REVIEW_UNAVAILABLE", "REVIEW_REQUIRED"]).toContain(review.status);
    await expect(orchestration.resumeRun(context, started.id)).rejects.toThrow(/still pending/);

    // PUBLISH while the M11 approval is missing: M13 preflight refuses, the step fails final.
    const post = await publishing.createScheduledPost(context, {
      channelId,
      renderJobId,
      qualityReviewRunId: reviewId,
      scheduledAt: null,
      disclosure: { decision: "NOT_REQUIRED", reason: "Fixture content" },
      destinations: [
        {
          platform: "YOUTUBE",
          socialAccountId,
          metadata: {
            platform: "YOUTUBE",
            title: "M16 fixture",
            description: "Fixture",
            privacyStatus: "private",
            selfDeclaredMadeForKids: false,
          },
        },
      ],
    });
    const destinationId = post.destinations[0]?.id;
    expect(destinationId).toBeDefined();
    const publishRun = await orchestration.startManualRun(context, {
      definitionKey: "PUBLISH",
      channelId,
      publishingDestinationId: destinationId,
    });
    await drain(orchestration);
    const refused = await orchestration.getRun(context, publishRun.id);
    const publishStep = refused.steps.find((step) => step.stepKey === "PUBLISH");
    expect(refused.state).toBe("FAILED");
    expect(refused.lastErrorCode).toBe("DOMAIN_REJECTED_409");
    expect(refused.lastErrorMessage).toContain("Publishing is blocked");
    expect(publishStep).toMatchObject({ status: "FAILED", attempts: 1 });
    const destination = (await publishing.getScheduledPost(context, post.id)).destinations[0];
    expect(destination?.status).not.toBe("PUBLISHED");
    expect(await db.publishAttempt.count({ where: { workspaceId } })).toBe(0);

    // Human approves in M11, then resume completes the generation run.
    await quality.decide(context, reviewId, {
      action: "APPROVE",
      reason: "Reviewed by a human in the M16 integration test",
    });
    const resumed = await orchestration.resumeRun(context, started.id);
    expect(resumed.state).toBe("SUCCEEDED");
    expect(resumed.events.map((event) => event.eventType)).toContain("WORKFLOW_APPROVAL_GRANTED");
    for (const step of resumed.steps) expect(["SUCCEEDED", "SKIPPED"]).toContain(step.status);
  }, 60_000);
});
