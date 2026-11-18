import { describe, expect, it, vi } from "vitest";
import { planningFixture, context } from "../script/planning.fixture.js";
import type { Run, Step } from "../runs/runs.types.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import type { CriticEvidence } from "./critic-evidence.js";
import { CriticPipeline } from "./critic.pipeline.js";
import type { TextSpec } from "@reelforge/ai-providers";
import { RunCritic } from "./run-critic.js";

function fixture(
  budget: unknown = {
    hardCapMinor: 800,
    baseEstimateMinor: 600,
    reshootReserveMinor: 200,
    spentMinor: 100,
    reservedMinor: 0,
  },
  hasRights = true,
  real = false,
  badClip = false,
  noRefs = false,
): {
  service: RunCritic;
  review: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  native: ReturnType<typeof vi.fn>;
} {
  const ref = {
    assetId: "a",
    assetVersion: 1,
    checksumSha256: "checksum",
    rights: { license: "license", rightsHolder: "holder", attestedAt: "2026-01-01T00:00:00Z" },
  };
  const asset = {
    id: "a",
    version: 1,
    checksumSha256: "checksum",
    status: "PUBLISHED",
    licenseType: "license",
    licenseTerms: "terms",
    rightsHolder: "holder",
    rightsAttestedAt: new Date(),
  };
  const db = {
    budgetEnvelope: {
      findFirst: async (): Promise<unknown> => budget,
      findFirstOrThrow: async (): Promise<unknown> => budget,
    },
    videoRun: { findMany: async (): Promise<never[]> => [] },
    videoRunStep: {
      findFirst: async (): Promise<null> => null,
      updateMany: async (): Promise<void> => undefined,
    },
  };
  const access = {
    boundary: { check: async (): Promise<void> => undefined },
    runs: {
      store: {
        scoped: () => db,
        db: {
          asset: { findMany: async (): Promise<(typeof asset)[]> => (hasRights ? [asset] : []) },
        },
      },
    },
    modules: { get: () => ({ resolve: async (): Promise<(typeof ref)[]> => [ref] }) },
  } as unknown as MediaAccess;
  const load = vi.fn(async () => ({
    final: Buffer.from("real fixture"),
    clips: [
      {
        id: "0",
        probe: {
          durationSeconds: 6,
          width: 720,
          height: 1280,
          hasBlackFrames: badClip,
          hasFrozenFrames: false,
          captionDriftMs: 0,
        },
        hookText: "hook",
        narrativeText: "trees",
        visualDescription: "trees",
        captionText: "trees",
      },
    ],
    plan: {
      script: { hook: "hook", beats: ["beat"], payoff: "payoff", cta: "cta" },
      manifest: { shots: [{ references: noRefs ? [] : [{ referenceAssetId: "a", version: 1 }] }] },
    },
  }));
  const review = vi.fn(async () => ({
    criticPassed: true,
    noveltyScore: 10,
    packaging: { title: "Topic" },
    details: { score: 8, rubric: { policy: 8, briefFit: 8 }, hardGates: [{ passed: true }] },
  }));
  const native = vi.fn(async <T>(spec: TextSpec<T>) => ({
    output: spec.parse({
      hook: 8,
      coherence: 8,
      artifacts: 8,
      captionSync: 8,
      briefFit: 8,
      policy: 8,
    }),
    providerJobId: "job",
    usage: {},
  }));
  const accounts = {
    begin: async () => ({ id: "paid", idempotencyKey: "idem" }),
    prepare: async () => undefined,
    complete: async () => undefined,
  } as unknown as MediaAccounts;
  const ports = { get: async () => ({ text: { complete: native } }) } as unknown as MediaPorts;
  return {
    service: new RunCritic(
      access,
      accounts,
      ports,
      { load } as unknown as CriticEvidence,
      real ? new CriticPipeline() : ({ reviewRun: review } as unknown as CriticPipeline),
    ),
    review,
    load,
    native,
  };
}
const request = planningFixture();
const run = {
  id: request.runId,
  workspaceId: context.workspaceId,
  channelId: request.brief.channelId,
  channelBriefId: request.brief.id,
  channelBriefVersion: request.brief.version,
  correlationId: "correlation",
} as Run;
const brief = request.brief;
const step = { attempt: 1 } as Step;
describe("V6 worker critic", () => {
  it("passes assembled video and measured clips to the run-scoped V6 boundary", async () => {
    const t = fixture();
    await expect(t.service.execute(context, run, brief, step)).resolves.toMatchObject({
      criticPassed: true,
      report: { recommendation: "APPROVE" },
    });
    expect(t.review).toHaveBeenCalledWith(
      expect.objectContaining({
        critic: expect.objectContaining({
          media: [
            {
              type: "video",
              mime_type: "video/mp4",
              data: Buffer.from("real fixture").toString("base64"),
            },
          ],
        }),
      }),
      expect.objectContaining({ run, context, attempt: 1 }),
    );
  });
  it("fails before loading media or calling the provider when budget is missing", async () => {
    const t = fixture(null);
    await expect(t.service.execute(context, run, brief, step)).rejects.toThrow("budget envelope");
    expect(t.load).not.toHaveBeenCalled();
    expect(t.review).not.toHaveBeenCalled();
  });
  it("does not call the provider without verified reference rights", async () => {
    const t = fixture(undefined, false);
    await expect(t.service.execute(context, run, brief, step)).rejects.toThrow("rights evidence");
    expect(t.review).not.toHaveBeenCalled();
  });
  it("allows a plan with no reference assets", async () => {
    const t = fixture(undefined, true, false, false, true);
    await expect(t.service.execute(context, run, brief, step)).resolves.toMatchObject({
      criticPassed: true,
    });
    expect(t.review).toHaveBeenCalledOnce();
  });
  it("runs the real V6 pipeline with a fake V2 provider", async () => {
    vi.stubEnv("PIPELINE_V2", "true");
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    try {
      const t = fixture(undefined, true, true);
      await expect(t.service.execute(context, run, brief, step)).resolves.toMatchObject({
        criticPassed: true,
        report: { recommendation: "APPROVE" },
      });
      expect(t.native).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("records a targeted reshoot when measured clip evidence fails", async () => {
    vi.stubEnv("PIPELINE_V2", "true");
    vi.stubEnv("GEMINI_TEXT_MODEL", "fixture");
    try {
      const t = fixture(undefined, true, true, true);
      await expect(t.service.execute(context, run, brief, step)).resolves.toMatchObject({
        criticPassed: false,
        redo: { shots: ["0"], reedit: false },
      });
      expect(t.native).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
