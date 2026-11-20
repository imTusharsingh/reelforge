import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { QUALITY_REVIEW_PORT, type QualityReviewPort } from "@reelforge/ai-providers";
import { DEFAULT_RENDER_PROFILE } from "@reelforge/media";
import { afterEach, expect, it, vi } from "vitest";
import { CompositionService } from "../composition/composition.service.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { QualityModule } from "./quality.module.js";
import { QualityService } from "./quality.service.js";

const context: WorkspaceContext = {
  workspaceId: randomUUID(),
  userId: randomUUID(),
  role: "OWNER",
};
const renderJobId = randomUUID();
const assetId = randomUUID();
const sceneMediaJob = {
  id: randomUUID(),
  scriptId: randomUUID(),
  scriptRevision: 1,
  channel: { approvalPolicy: { mode: "AUTO" } },
};
const input = {
  schemaVersion: "1.0",
  title: "Fixture",
  profile: DEFAULT_RENDER_PROFILE,
  sourceMediaPackage: {
    schemaVersion: "1.0",
    jobId: sceneMediaJob.id,
    scriptId: sceneMediaJob.scriptId,
    scriptRevision: sceneMediaJob.scriptRevision,
  },
  scenes: [{ sceneId: "one", assetId, assetVersion: 1, image: true, durationMs: 1000 }],
  coverFrames: [{ assetId, assetVersion: 1, timestampMs: 0 }],
  renderSeed: "fixture-seed",
};

afterEach(() => vi.unstubAllEnvs());

it.each([
  { enabled: false, hasRights: true, status: "REVIEW_REQUIRED" },
  { enabled: false, hasRights: false, status: "BLOCKED" },
  { enabled: true, hasRights: true, status: null },
])(
  "handles legacy review with pipeline.v2=$enabled and asset rights=$hasRights",
  async ({ enabled, hasRights, status }) => {
    vi.stubEnv("PIPELINE_V2", String(enabled));
    const create = vi.fn(async ({ data }: { data: object }) => ({
      ...data,
      id: randomUUID(),
      scorecard: null,
      decisions: [],
      regenerationRequests: [],
      createdAt: new Date(),
      supersededAt: null,
    }));
    const db = {
      renderJob: {
        findUnique: vi.fn(async () => ({
          id: renderJobId,
          parentJobId: null,
          input,
          sceneMediaJob,
        })),
      },
      scriptRevision: {
        findUnique: async (): Promise<object> => ({
          script: { snapshot: { references: [] } },
          document: {
            schemaVersion: "1.0",
            title: "Fixture",
            hook: "Hook",
            dialogue: "Dialogue",
            cta: "CTA",
            metadata: { genre: "Fixture", targetDurationSeconds: 2, factual: false },
            scenes: [
              {
                id: "one",
                startSeconds: 0,
                durationSeconds: 2,
                dialogue: "Line",
                visualDescription: "First frame",
                camera: "wide",
                audioCues: [],
              },
            ],
          },
        }),
      },
      genre: {
        findFirst: async (): Promise<object> => ({
          topicsAllowed: [],
          topicsBlocked: [],
          safetyProfile: { requiresSourceBackedClaims: false },
        }),
      },
      asset: {
        findMany: async (): Promise<object[]> => [
          {
            id: assetId,
            version: 1,
            ownership: "SYSTEM_GENERATED",
            status: "PUBLISHED",
            licenseType: "license",
            licenseTerms: "terms",
            rightsHolder: "owner",
            rightsAttestedAt: hasRights ? new Date() : null,
          },
        ],
      },
      assetUsageReference: {
        findMany: async (): Promise<object[]> => [{ assetId, assetVersion: 1 }],
      },
      qualityReviewRun: {
        findFirst: vi.fn(async () => null),
        findUnique: async (): Promise<object | undefined> => create.mock.results[0]?.value,
        create,
      },
      $transaction: async (callback: (tx: object) => Promise<unknown>): Promise<unknown> =>
        callback(db),
    };
    const module = await Test.createTestingModule({ imports: [QualityModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(CompositionService)
      .useValue({
        getManifest: async (): Promise<object> => ({
          renderProfile: input.profile,
          video: { durationMs: 1000, mediaType: "video/mp4" },
        }),
      })
      .compile();
    try {
      const port = module.get<QualityReviewPort>(QUALITY_REVIEW_PORT);
      await expect(
        port.review({
          correlationId: "fixture",
          title: "Fixture",
          hook: "Hook",
          dialogue: "Dialogue",
          narration: "",
          callToAction: "CTA",
          genre: "Fixture",
          allowedTopics: [],
          blockedTopics: [],
          claims: [],
          scenes: [],
          requiredDisclosures: [],
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED", correlationId: "fixture" });

      const result = module.get(QualityService).create(context, { renderJobId });
      if (status === null) {
        await expect(result).rejects.toThrow("New quality reviews require a pipeline.v2 run");
        expect(db.renderJob.findUnique).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toMatchObject({
          status,
          scorecard: null,
          disclosures: ["AI_GENERATED_ASSET"],
          gateSummary: expect.arrayContaining([
            { id: "ASSET_RIGHTS", passed: hasRights, evidence: expect.any(Array) },
          ]),
        });
        expect(create).toHaveBeenCalledTimes(1);
      }
    } finally {
      await module.close();
    }
  },
);
