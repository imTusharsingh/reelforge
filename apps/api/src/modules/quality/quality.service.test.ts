import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { DEFAULT_RENDER_PROFILE } from "@reelforge/media";
import { Prisma } from "@reelforge/database";
import { ProviderError } from "@reelforge/ai-providers";
import type { Database } from "../identity/identity.types.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import type {
  QualityReviewPort,
  QualityReviewRequest,
  QualityReviewResult,
} from "@reelforge/ai-providers";
import type { CompositionService } from "../composition/composition.service.js";
import type { RenderManifest } from "../composition/composition.manifest.js";
import type { RenderCompositionInput } from "../composition/composition.types.js";
import type { ScriptDocument } from "../script/script.types.js";
import type { QualityRunStatus } from "./quality.types.js";
import { QualityService } from "./quality.service.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const renderJobId = "44444444-4444-4444-8444-444444444444";
const scriptId = "55555555-5555-4555-8555-555555555555";
const assetId = "66666666-6666-4666-8666-666666666666";
const sceneMediaJobId = "77777777-7777-4777-8777-777777777777";
const renderProfile = {
  ...DEFAULT_RENDER_PROFILE,
  captionSafeMarginPixels: 120,
  transition: "CUT" as const,
  transitionDurationMs: 0,
};

function context(role: WorkspaceContext["role"] = "OWNER", id = workspaceId): WorkspaceContext {
  return { workspaceId: id, userId, role };
}

function input(): RenderCompositionInput {
  return {
    schemaVersion: "1.0",
    title: "Test render",
    profile: renderProfile,
    sourceMediaPackage: {
      jobId: sceneMediaJobId,
      scriptId,
      scriptRevision: 1,
      schemaVersion: "1.0",
    },
    scenes: [
      {
        sceneId: "scene-1",
        assetId,
        assetVersion: 1,
        image: true,
        durationMs: 10_000,
        captions: [{ text: "hello", startMs: 0, endMs: 1_000 }],
      },
    ],
    audio: [],
    coverFrames: [{ assetId, assetVersion: 1, timestampMs: 0 }],
    renderSeed: "quality-test-seed",
  };
}

function manifest(jobId = renderJobId): RenderManifest {
  return {
    schemaVersion: "1.0",
    jobId,
    title: "Test render",
    renderSeed: "quality-test-seed",
    renderProfile,
    sourceMediaPackage: input().sourceMediaPackage,
    pinnedInputs: { scenes: input().scenes, audio: [], coverFrames: input().coverFrames },
    video: {
      filename: "final.mp4",
      mediaType: "video/mp4",
      byteSize: 123,
      checksumSha256: "a".repeat(64),
      durationMs: 10_000,
    },
    artifactOrder: ["VIDEO", "COVER", "MANIFEST"],
    covers: [],
  };
}

function scriptDocument(dialogue = "A short clear story"): ScriptDocument {
  return {
    schemaVersion: "1.0",
    title: "Test story",
    hook: "A clear hook",
    dialogue,
    narration: "",
    cta: "Learn more",
    metadata: { genre: "Science", targetDurationSeconds: 10, factual: false },
    scenes: [
      {
        id: "scene-1",
        startSeconds: 0,
        durationSeconds: 10,
        characterRefs: [],
        dialogue,
        narration: "",
        visualDescription: "A bright illustration",
        camera: "Static",
        audioCues: [],
      },
    ],
  };
}

function fixtureResult(score = 90): QualityReviewResult {
  const result = {
    score,
    evidence: ["The script presents a coherent opening and conclusion"],
    limitations: ["The review does not verify claims against external sources"],
  };
  return {
    criteria: {
      FACTUALITY: result,
      CLARITY: result,
      COHERENCE: result,
      ENGAGEMENT: result,
      GENRE_FIT: result,
    },
    metadata: { modelVersion: "fixture-v1", promptVersion: "qa-v1", cost: 0 },
  };
}

type StoredDecision = {
  id: string;
  action: "APPROVE" | "REJECT" | "REQUEST_CHANGES";
  reason: string;
  actorUserId: string;
  createdAt: Date;
};

type StoredRegeneration = {
  id: string;
  stage: "SCENE" | "SCRIPT" | "RENDER";
  sceneId: string | null;
  attempt: number;
  createdAt: Date;
  workspaceId: string;
  renderFamilyId: string;
  targetKey: string;
};

type StoredRun = {
  id: string;
  workspaceId: string;
  renderJobId: string;
  renderFamilyId: string;
  createdByUserId: string;
  status: QualityRunStatus;
  gateSummary: unknown;
  scorecard: unknown;
  policySnapshot: unknown;
  disclosures: unknown;
  limitations: unknown;
  modelVersion: string | null;
  promptVersion: string | null;
  createdAt: Date;
  decisions: StoredDecision[];
  regenerationRequests: StoredRegeneration[];
  renderJob: { input: RenderCompositionInput };
};

class FixtureDatabase {
  public readonly runs = new Map<string, StoredRun>();
  public readonly regenerations: StoredRegeneration[] = [];
  public assetOwnership: "USER_UPLOADED" | "STARTER_LIBRARY" | "SYSTEM_GENERATED" = "USER_UPLOADED";
  public rightsAttestedAt: Date | null = new Date("2026-01-01T00:00:00Z");
  public hasInputProvenance = true;
  private readonly jobs = new Map<
    string,
    {
      id: string;
      workspaceId: string;
      parentJobId: string | null;
      input: RenderCompositionInput;
      sceneMediaJob: {
        id: string;
        scriptId: string;
        scriptRevision: number;
        channel: { approvalPolicy: unknown };
      };
    }
  >();
  public approvalPolicy: unknown = null;
  public blockedTopics: unknown = [];
  public script = scriptDocument();
  public constructor() {
    this.addJob(renderJobId, null);
  }
  public addJob(id: string, parentJobId: string | null): void {
    const renderInput = input();
    this.jobs.set(id, {
      id,
      workspaceId,
      parentJobId,
      input: renderInput,
      sceneMediaJob: {
        id: sceneMediaJobId,
        scriptId,
        scriptRevision: 1,
        channel: { approvalPolicy: this.approvalPolicy },
      },
    });
  }
  public readonly renderJob = {
    findUnique: async (args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
    }): Promise<unknown> => {
      const { workspaceId: requestedWorkspace, id } = args.where.workspaceId_id;
      if (requestedWorkspace !== workspaceId) return null;
      const job = this.jobs.get(id);
      return job
        ? {
            ...job,
            sceneMediaJob: {
              ...job.sceneMediaJob,
              channel: { approvalPolicy: this.approvalPolicy },
            },
          }
        : null;
    },
  };
  public readonly scriptRevision = {
    findUnique: async (): Promise<unknown> => ({
      document: this.script,
      script: { snapshot: { references: [] } },
    }),
  };
  public readonly genre = {
    findFirst: async (): Promise<unknown> => ({
      name: "Science",
      topicsAllowed: ["science"],
      topicsBlocked: this.blockedTopics,
      safetyProfile: { requiresSourceBackedClaims: false },
    }),
  };
  public readonly asset = {
    findMany: async (): Promise<unknown[]> => [
      {
        id: assetId,
        version: 1,
        ownership: this.assetOwnership,
        status: "PUBLISHED",
        licenseType: "CC-BY-4.0",
        licenseTerms: "Use permitted",
        rightsHolder: "Fixture creator",
        rightsAttestedAt: this.rightsAttestedAt,
      },
    ],
  };
  public readonly assetUsageReference = {
    findMany: async (): Promise<unknown[]> =>
      this.hasInputProvenance ? [{ assetId, assetVersion: 1 }] : [],
  };
  public readonly qualityReviewRun = {
    create: async (args: { data: Record<string, unknown> }): Promise<{ id: string }> => {
      const run = {
        ...args.data,
        scorecard: args.data.scorecard === Prisma.JsonNull ? null : args.data.scorecard,
        id: randomUUID(),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        decisions: [],
        regenerationRequests: [],
        renderJob: {
          input: this.jobs.get(args.data["renderJobId"] as string)?.input ?? input(),
        },
      } as unknown as StoredRun;
      this.runs.set(run.id, run);
      return { id: run.id };
    },
    findUnique: async (args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
    }): Promise<StoredRun | null> => {
      const run = this.runs.get(args.where.workspaceId_id.id);
      return run?.workspaceId === args.where.workspaceId_id.workspaceId ? run : null;
    },
    findMany: async (args: {
      where: { workspaceId: string; status: QualityRunStatus };
    }): Promise<StoredRun[]> =>
      [...this.runs.values()].filter(
        (run) => run.workspaceId === args.where.workspaceId && run.status === args.where.status,
      ),
    updateMany: async (args: {
      where: { workspaceId: string; id: string; status: QualityRunStatus };
      data: { status: QualityRunStatus };
    }): Promise<{ count: number }> => {
      const run = this.runs.get(args.where.id);
      if (!run || run.workspaceId !== args.where.workspaceId || run.status !== args.where.status)
        return { count: 0 };
      run.status = args.data.status;
      return { count: 1 };
    },
  };
  public readonly qualityDecision = {
    create: async (args: {
      data: {
        workspaceId: string;
        reviewRunId: string;
        actorUserId: string;
        action: StoredDecision["action"];
        reason: string;
      };
    }): Promise<{ id: string }> => {
      const decision = {
        id: randomUUID(),
        action: args.data.action,
        reason: args.data.reason,
        actorUserId: args.data.actorUserId,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      };
      this.runs.get(args.data.reviewRunId)?.decisions.push(decision);
      return { id: decision.id };
    },
  };
  public readonly qualityRegenerationRequest = {
    count: async (args: {
      where: { workspaceId: string; renderFamilyId: string; targetKey: string };
    }): Promise<number> =>
      this.regenerations.filter(
        (request) =>
          request.workspaceId === args.where.workspaceId &&
          request.renderFamilyId === args.where.renderFamilyId &&
          request.targetKey === args.where.targetKey,
      ).length,
    create: async (args: {
      data: {
        workspaceId: string;
        renderJobId: string;
        renderFamilyId: string;
        targetKey: string;
        stage: StoredRegeneration["stage"];
        sceneId: string | null;
        attempt: number;
        reviewRunId: string;
      };
    }): Promise<StoredRegeneration> => {
      const request: StoredRegeneration = {
        id: randomUUID(),
        stage: args.data.stage,
        sceneId: args.data.sceneId,
        attempt: args.data.attempt,
        createdAt: new Date("2026-01-02T00:00:00Z"),
        workspaceId: args.data.workspaceId,
        renderFamilyId: args.data.renderFamilyId,
        targetKey: args.data.targetKey,
      };
      this.regenerations.push(request);
      this.runs.get(args.data.reviewRunId)?.regenerationRequests.push(request);
      return request;
    },
  };

  public async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
    return callback({
      qualityReviewRun: this.qualityReviewRun,
      qualityDecision: this.qualityDecision,
      qualityRegenerationRequest: this.qualityRegenerationRequest,
    });
  }
}

function service(
  db: FixtureDatabase,
  reviewer: QualityReviewPort = { review: async () => fixtureResult() },
): QualityService {
  const composition = {
    getManifest: vi.fn(async (_context: WorkspaceContext, jobId: string) => manifest(jobId)),
  };
  return new QualityService(
    db as unknown as Database,
    composition as unknown as CompositionService,
    reviewer,
  );
}

describe("quality review service", () => {
  it("uses manual review by default and stores criterion evidence and limitations", async () => {
    const db = new FixtureDatabase();
    const response = await service(db).create(context(), { renderJobId });

    expect(response.status).toBe("REVIEW_REQUIRED");
    expect(response.scorecard?.score).toBe(90);
    expect(response.scorecard?.criteria.FACTUALITY.evidence).toHaveLength(1);
    expect(response.limitations).toContain(
      "The review does not verify claims against external sources",
    );
    expect(response.policySnapshot.mode).toBe("MANUAL");
    expect((await service(db).queue(context())).map((run) => run.id)).toContain(response.id);
  });

  it("does not allow a failed hard gate to be approved", async () => {
    const db = new FixtureDatabase();
    db.blockedTopics = ["short clear story"];
    const quality = service(db);
    const response = await quality.create(context(), { renderJobId });

    expect(response.status).toBe("BLOCKED");
    expect(response.gateSummary.find((result) => result.id === "GENRE_POLICY")?.passed).toBe(false);
    await expect(
      quality.decide(context(), response.id, { action: "APPROVE", reason: "Looks good" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("checks blocked topics in claims, camera directions, and audio cues", async () => {
    const baseScript = scriptDocument();
    const cases: ReadonlyArray<Readonly<{ term: string; script: ScriptDocument }>> = [
      {
        term: "blocked claim",
        script: {
          ...baseScript,
          claims: [{ text: "blocked claim", sourceUrl: "https://example.test/source" }],
        },
      },
      {
        term: "blocked camera",
        script: {
          ...baseScript,
          scenes: baseScript.scenes.map((scene) => ({ ...scene, camera: "blocked camera" })),
        },
      },
      {
        term: "blocked cue",
        script: {
          ...baseScript,
          scenes: baseScript.scenes.map((scene) => ({
            ...scene,
            audioCues: ["blocked cue"],
          })),
        },
      },
    ];

    for (const { term, script: candidate } of cases) {
      const db = new FixtureDatabase();
      db.blockedTopics = [term];
      db.script = candidate;

      const response = await service(db).create(context(), { renderJobId });

      expect(response.status).toBe("BLOCKED");
      expect(response.gateSummary.find((result) => result.id === "GENRE_POLICY")?.passed).toBe(
        false,
      );
    }
  });

  it("honors configured automatic thresholds only when all gates and scores pass", async () => {
    const db = new FixtureDatabase();
    db.approvalPolicy = {
      mode: "AUTO",
      scoreThreshold: 80,
      criterionThresholds: { FACTUALITY: 95 },
    };
    const response = await service(db).create(context(), { renderJobId });

    expect(response.status).toBe("REVIEW_REQUIRED");
    expect(response.scorecard?.score).toBe(90);
  });

  it("auto-approves only when an explicitly configured policy threshold is met", async () => {
    const db = new FixtureDatabase();
    db.approvalPolicy = { mode: "AUTO", scoreThreshold: 80 };
    const response = await service(db).create(context(), { renderJobId });

    expect(response.status).toBe("AUTO_APPROVED");
    expect(response.gateSummary.every((result) => result.passed)).toBe(true);
  });

  it("exports required disclosure flags and blocks incomplete rights provenance", async () => {
    const disclosedDb = new FixtureDatabase();
    disclosedDb.assetOwnership = "SYSTEM_GENERATED";
    const disclosed = await service(disclosedDb).create(context(), { renderJobId });
    expect(disclosed.disclosures).toContain("AI_GENERATED_ASSET");

    const unverifiedDb = new FixtureDatabase();
    unverifiedDb.rightsAttestedAt = null;
    const blocked = await service(unverifiedDb).create(context(), { renderJobId });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.gateSummary.find((result) => result.id === "ASSET_RIGHTS")?.passed).toBe(false);
  });

  it("fails closed with an explicit unavailable status when no AI adapter is configured", async () => {
    const db = new FixtureDatabase();
    const unconfigured: QualityReviewPort = {
      review: async (request: QualityReviewRequest): Promise<QualityReviewResult> => {
        throw new ProviderError(
          "NOT_CONFIGURED",
          "No fixture adapter is configured",
          request.correlationId,
        );
      },
    };
    const response = await service(db, unconfigured).create(context(), { renderJobId });

    expect(response.status).toBe("AI_REVIEW_UNAVAILABLE");
    expect(response.scorecard).toBeNull();
    await expect(
      service(db, unconfigured).decide(context(), response.id, {
        action: "APPROVE",
        reason: "No AI result",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("denies viewer mutations and cross-workspace reads", async () => {
    const db = new FixtureDatabase();
    const quality = service(db);

    await expect(quality.create(context("VIEWER"), { renderJobId })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const pending = await quality.create(context(), { renderJobId });
    await expect(
      quality.decide(context("VIEWER"), pending.id, {
        action: "APPROVE",
        reason: "Viewer cannot approve",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      quality.get(context("OWNER", otherWorkspaceId), pending.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("stores an approval action, reviewer, timestamp, and reason", async () => {
    const db = new FixtureDatabase();
    const quality = service(db);
    const pending = await quality.create(context(), { renderJobId });
    const approved = await quality.decide(context(), pending.id, {
      action: "APPROVE",
      reason: "All gates pass and the script is acceptable",
    });

    expect(approved.status).toBe("APPROVED");
    expect(approved.decisions).toMatchObject([
      {
        action: "APPROVE",
        reason: "All gates pass and the script is acceptable",
        actorUserId: userId,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("stores reviewer decisions and caps regeneration requests across render retries", async () => {
    const db = new FixtureDatabase();
    const quality = service(db);
    const first = await quality.create(context(), { renderJobId });
    const firstDecision = await quality.decide(context(), first.id, {
      action: "REQUEST_CHANGES",
      reason: "Fix scene one",
      regeneration: { stage: "SCENE", sceneId: "scene-1" },
    });
    expect(firstDecision.status).toBe("CHANGES_REQUESTED");
    expect(firstDecision.decisions[0]?.actorUserId).toBe(userId);
    expect(firstDecision.regenerationRequests[0]?.attempt).toBe(1);

    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const retryId = randomUUID();
      db.addJob(retryId, renderJobId);
      const run = await quality.create(context(), { renderJobId: retryId });
      await quality.decide(context(), run.id, {
        action: "REQUEST_CHANGES",
        reason: `Fix scene one, attempt ${attempt}`,
        regeneration: { stage: "SCENE", sceneId: "scene-1" },
      });
    }

    const fourthRetryId = randomUUID();
    db.addJob(fourthRetryId, renderJobId);
    const fourth = await quality.create(context(), { renderJobId: fourthRetryId });
    await expect(
      quality.decide(context(), fourth.id, {
        action: "REQUEST_CHANGES",
        reason: "One more attempt",
        regeneration: { stage: "SCENE", sceneId: "scene-1" },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.regenerations.map((request) => request.attempt)).toEqual([1, 2, 3]);
  });
});
