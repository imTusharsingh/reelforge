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
  overrideReason: string | null;
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
  lineageKey: string;
  targetKey: string;
};

type StoredRun = {
  id: string;
  workspaceId: string;
  renderJobId: string;
  renderFamilyId: string;
  createdByUserId: string;
  status: QualityRunStatus;
  supersededAt: Date | null;
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
  renderJob: {
    input: RenderCompositionInput;
    sceneMediaJob: { id: string; scriptId: string; scriptRevision: number };
  };
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
      if (args.data.scorecard === Prisma.JsonNull)
        throw new Error("JSON null is not SQL NULL for quality scorecards");
      const run = {
        ...args.data,
        scorecard: args.data.scorecard === Prisma.DbNull ? null : args.data.scorecard,
        id: randomUUID(),
        createdAt: new Date("2026-01-01T00:00:00Z"),
        decisions: [],
        regenerationRequests: [],
        renderJob: {
          input: this.jobs.get(args.data["renderJobId"] as string)?.input ?? input(),
          sceneMediaJob: {
            id: sceneMediaJobId,
            scriptId,
            scriptRevision: 1,
          },
        },
        supersededAt: null,
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
      where: {
        workspaceId: string;
        status: QualityRunStatus | { in: QualityRunStatus[] };
        supersededAt?: null;
      };
    }): Promise<StoredRun[]> =>
      [...this.runs.values()].filter(
        (run) =>
          run.workspaceId === args.where.workspaceId &&
          (typeof args.where.status === "string"
            ? run.status === args.where.status
            : args.where.status.in.includes(run.status)) &&
          (args.where.supersededAt !== null || run.supersededAt === null),
      ),
    findFirst: async (args: {
      where: { workspaceId: string; renderJobId: string };
    }): Promise<StoredRun | null> =>
      [...this.runs.values()]
        .reverse()
        .find(
          (run) =>
            run.workspaceId === args.where.workspaceId &&
            run.renderJobId === args.where.renderJobId &&
            run.status !== "SUPERSEDED" &&
            run.supersededAt === null,
        ) ?? null,
    updateMany: async (args: {
      where: {
        workspaceId: string;
        id?: string;
        renderJobId?: string;
        status: QualityRunStatus | { in: QualityRunStatus[] };
        supersededAt?: null;
      };
      data: { status: QualityRunStatus; supersededAt?: Date };
    }): Promise<{ count: number }> => {
      const candidates = [...this.runs.values()].filter(
        (run) =>
          run.workspaceId === args.where.workspaceId &&
          (args.where.id === undefined || run.id === args.where.id) &&
          (args.where.renderJobId === undefined || run.renderJobId === args.where.renderJobId) &&
          (typeof args.where.status === "string"
            ? run.status === args.where.status
            : args.where.status.in.includes(run.status)) &&
          (args.where.supersededAt !== null || run.supersededAt === null),
      );
      for (const run of candidates) {
        run.status = args.data.status;
        if (args.data.supersededAt !== undefined) run.supersededAt = args.data.supersededAt;
      }
      return { count: candidates.length };
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
        overrideReason: string | null;
      };
    }): Promise<{ id: string }> => {
      const decision = {
        id: randomUUID(),
        action: args.data.action,
        reason: args.data.reason,
        overrideReason: args.data.overrideReason,
        actorUserId: args.data.actorUserId,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      };
      this.runs.get(args.data.reviewRunId)?.decisions.push(decision);
      return { id: decision.id };
    },
  };
  public readonly qualityRegenerationRequest = {
    count: async (args: {
      where: { workspaceId: string; lineageKey: string; targetKey: string };
    }): Promise<number> =>
      this.regenerations.filter(
        (request) =>
          request.workspaceId === args.where.workspaceId &&
          request.lineageKey === args.where.lineageKey &&
          request.targetKey === args.where.targetKey,
      ).length,
    create: async (args: {
      data: {
        workspaceId: string;
        renderJobId: string;
        renderFamilyId: string;
        lineageKey: string;
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
        lineageKey: args.data.lineageKey,
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
      scriptRevision: this.scriptRevision,
      genre: this.genre,
      asset: this.asset,
      assetUsageReference: this.assetUsageReference,
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

  it("rejects a blocked run and routes genre-policy failures to script regeneration", async () => {
    const db = new FixtureDatabase();
    db.blockedTopics = ["short clear story"];
    const quality = service(db);
    const response = await quality.create(context(), { renderJobId });

    expect(response.status).toBe("BLOCKED");
    expect(response.gateSummary.find((result) => result.id === "GENRE_POLICY")?.passed).toBe(false);
    expect((await quality.queue(context())).map((run) => run.id)).toContain(response.id);
    await expect(
      quality.decide(context(), response.id, { action: "APPROVE", reason: "Looks good" }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      quality.decide(context(), response.id, {
        action: "REQUEST_CHANGES",
        reason: "Fix the blocked topic",
        regeneration: { stage: "RENDER" },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const routed = await quality.decide(context(), response.id, {
      action: "REQUEST_CHANGES",
      reason: "Revise the script to remove the blocked topic",
      regeneration: { stage: "SCRIPT" },
    });
    expect(routed.status).toBe("CHANGES_REQUESTED");
    expect(routed.regenerationRequests[0]).toMatchObject({ stage: "SCRIPT", attempt: 1 });
  });

  it("allows rejecting a blocked run and records a reason for a route override", async () => {
    const blockedDb = new FixtureDatabase();
    blockedDb.rightsAttestedAt = null;
    const rejectQuality = service(blockedDb);
    const rejectedRun = await rejectQuality.create(context(), { renderJobId });
    const rejected = await rejectQuality.decide(context(), rejectedRun.id, {
      action: "REJECT",
      reason: "Rights attestation is missing",
    });
    expect(rejected.status).toBe("REJECTED");

    const overrideDb = new FixtureDatabase();
    overrideDb.blockedTopics = ["short clear story"];
    const overrideQuality = service(overrideDb);
    const blocked = await overrideQuality.create(context(), { renderJobId });
    const overridden = await overrideQuality.decide(context(), blocked.id, {
      action: "REQUEST_CHANGES",
      reason: "Request a render despite the script gate",
      overrideReason: "The script was corrected outside this render workflow",
      regeneration: { stage: "RENDER" },
    });
    expect(overridden.decisions[0]?.overrideReason).toBe(
      "The script was corrected outside this render workflow",
    );
  });

  it("routes an asset-rights failure to the scene using the offending asset", async () => {
    const db = new FixtureDatabase();
    db.rightsAttestedAt = null;
    const quality = service(db);
    const blocked = await quality.create(context(), { renderJobId });
    const routed = await quality.decide(context(), blocked.id, {
      action: "REQUEST_CHANGES",
      reason: "Replace the unverified scene asset",
      regeneration: { stage: "SCENE", sceneId: "scene-1" },
    });

    expect(routed.status).toBe("CHANGES_REQUESTED");
    expect(routed.regenerationRequests[0]).toMatchObject({
      stage: "SCENE",
      sceneId: "scene-1",
      attempt: 1,
    });
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

  it("never auto-approves a high score when a hard gate fails", async () => {
    const db = new FixtureDatabase();
    db.approvalPolicy = { mode: "AUTO", scoreThreshold: 80 };
    db.blockedTopics = ["short clear story"];
    const reviewer: QualityReviewPort = { review: vi.fn(async () => fixtureResult(100)) };

    const response = await service(db, reviewer).create(context(), { renderJobId });

    expect(response.status).toBe("BLOCKED");
    expect(response.scorecard).toBeNull();
    expect(reviewer.review).not.toHaveBeenCalled();
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

  it("queues unconfigured AI results for human review and never auto-approves them", async () => {
    const db = new FixtureDatabase();
    db.approvalPolicy = { mode: "AUTO", scoreThreshold: 80 };
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

    expect(response.status).toBe("REVIEW_REQUIRED");
    expect(response.scorecard).toBeNull();
    expect(response.limitations).toContain(
      "AI quality review is unavailable; this run requires human review and cannot be auto-approved",
    );
    expect((await service(db, unconfigured).queue(context())).map((run) => run.id)).toContain(
      response.id,
    );
    const approved = await service(db, unconfigured).decide(context(), response.id, {
      action: "APPROVE",
      reason: "Manual review completed; all hard gates pass",
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.scorecard).toBeNull();
  });

  it("denies viewer mutations and cross-workspace create, read, and decision access", async () => {
    const db = new FixtureDatabase();
    const quality = service(db);

    await expect(quality.create(context("VIEWER"), { renderJobId })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      quality.create(context("OWNER", otherWorkspaceId), { renderJobId }),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    await expect(
      quality.decide(context("OWNER", otherWorkspaceId), pending.id, {
        action: "REJECT",
        reason: "Cross-workspace decision",
      }),
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
        overrideReason: null,
        actorUserId: userId,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("supersedes earlier pending runs and exports the latest render status", async () => {
    const db = new FixtureDatabase();
    const quality = service(db);
    const first = await quality.create(context(), { renderJobId });
    db.blockedTopics = ["short clear story"];
    const latest = await quality.create(context(), { renderJobId });

    expect(latest.status).toBe("BLOCKED");
    expect((await quality.get(context(), first.id)).status).toBe("SUPERSEDED");
    expect((await quality.get(context(), first.id)).supersededAt).not.toBeNull();
    await expect(
      quality.decide(context(), first.id, {
        action: "APPROVE",
        reason: "Attempt stale approval",
      }),
    ).rejects.toThrow("Only a current pending review can receive a decision");
    await expect(quality.getRenderQualityStatus(context(), renderJobId)).resolves.toMatchObject({
      renderJobId,
      status: "BLOCKED",
      gateSummary: latest.gateSummary,
    });
  });

  it("rechecks current rights and genre gates inside approval", async () => {
    const rightsDb = new FixtureDatabase();
    const rightsQuality = service(rightsDb);
    const rightsPending = await rightsQuality.create(context(), { renderJobId });
    rightsDb.rightsAttestedAt = null;
    await expect(
      rightsQuality.decide(context(), rightsPending.id, {
        action: "APPROVE",
        reason: "Rights changed after evaluation",
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const genreDb = new FixtureDatabase();
    const genreQuality = service(genreDb);
    const genrePending = await genreQuality.create(context(), { renderJobId });
    genreDb.blockedTopics = ["short clear story"];
    await expect(
      genreQuality.decide(context(), genrePending.id, {
        action: "APPROVE",
        reason: "Policy changed after evaluation",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("stores reviewer decisions and caps regeneration across renders in one script lineage", async () => {
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
      db.addJob(retryId, null);
      const run = await quality.create(context(), { renderJobId: retryId });
      await quality.decide(context(), run.id, {
        action: "REQUEST_CHANGES",
        reason: `Fix scene one, attempt ${attempt}`,
        regeneration: { stage: "SCENE", sceneId: "scene-1" },
      });
    }

    const fourthRetryId = randomUUID();
    db.addJob(fourthRetryId, null);
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
