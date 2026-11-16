import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  BudgetEnvelopeSchema,
  FormatMixSchema,
  GuardrailsSchema,
  ProviderCapabilitySchema,
  ShotSpecSchema,
  TuningBoundsSchema,
  VIDEO_RUN_TRANSITIONS,
  VideoRunStateSchema,
} from "./index.js";
const base = { id: randomUUID(), workspaceId: randomUUID(), schemaVersion: "1.0" };
it("matches every edge and terminal of the locked Page diagram", () => {
  expect(VIDEO_RUN_TRANSITIONS).toEqual({
    PLANNING: ["SCRIPTING", "CANCELED"],
    SCRIPTING: ["SHOT_PLANNING"],
    SHOT_PLANNING: ["GENERATING"],
    GENERATING: ["ASSEMBLING", "PAUSED_BUDGET", "FAILED"],
    ASSEMBLING: ["CRITIC"],
    CRITIC: ["AWAITING_APPROVAL", "GENERATING", "NEEDS_HUMAN"],
    AWAITING_APPROVAL: ["SCHEDULED"],
    SCHEDULED: ["PUBLISHED"],
    PUBLISHED: ["LEARNING"],
    LEARNING: [],
    PAUSED_BUDGET: ["GENERATING"],
    NEEDS_HUMAN: ["GENERATING"],
    FAILED: [],
    CANCELED: [],
  });
  expect(Object.keys(VIDEO_RUN_TRANSITIONS).sort()).toEqual(
    [...VideoRunStateSchema.options].sort(),
  );
  for (const targets of Object.values(VIDEO_RUN_TRANSITIONS))
    for (const target of targets) expect(VideoRunStateSchema.safeParse(target).success).toBe(true);
  expect(VideoRunStateSchema.safeParse("RUNNING").success).toBe(false);
});
it("pins Director prompts, VO, continuity and chained frames", () => {
  const shot = {
    ...base,
    runId: randomUUID(),
    ordinal: 1,
    version: 1,
    keyframePrompt: "A tree",
    motionPrompt: "Pan left",
    negativePrompt: "",
    durationSeconds: 7.5,
    voLine: "Leaves change",
    dialogue: "",
    onScreenText: "Autumn",
    continuityNotes: ["Same tree"],
    firstFrameFrom: { previousShotOrdinal: 0 },
    camera: "wide",
    transition: "CUT",
    references: [],
    width: 720,
    height: 1280,
    fps: 24,
    seed: null,
  };
  expect(ShotSpecSchema.safeParse(shot).success).toBe(true);
  expect(
    ShotSpecSchema.safeParse({
      ...shot,
      firstFrameFrom: { referenceAssetId: randomUUID(), version: 2 },
    }).success,
  ).toBe(true);
  expect(ShotSpecSchema.safeParse({ ...shot, firstFrameFrom: null }).success).toBe(true);
  expect(
    ShotSpecSchema.safeParse({ ...shot, firstFrameFrom: { previousShotOrdinal: 1 } }).success,
  ).toBe(false);
  expect(ShotSpecSchema.safeParse({ ...shot, width: 1280, height: 720 }).success).toBe(false);
  expect(ShotSpecSchema.safeParse({ ...shot, durationSeconds: 11 }).success).toBe(false);
  expect(
    ShotSpecSchema.safeParse({
      ...shot,
      references: Array.from({ length: 7 }, () => ({ referenceAssetId: randomUUID(), version: 1 })),
    }).success,
  ).toBe(false);
});
it("uses micro-USD for exact sub-cent per-second catalog prices and supports MUSIC", () => {
  const capability = {
    ...base,
    providerId: "configured-provider",
    modelId: "from-config",
    kind: "VIDEO",
    enabled: false,
    aspects: ["9:16"],
    maxReferenceImages: 6,
    firstLastFrame: true,
    minExtensionSeconds: 3,
    maxExtensionPerTurnSeconds: 10,
    maxExtensionSeconds: 30,
    nativeAudio: true,
    health: "HEALTHY",
    pricePerSecond: { "360p": 23000, "720p": 69504, "1080p": 104000 },
    supportsReferenceImages: true,
    supportsAudio: true,
    asynchronous: true,
    polling: true,
    minDurationSeconds: 3,
    maxDurationSeconds: 15,
    resolutions: [{ width: 720, height: 1280 }],
    frameRates: [24],
    regions: [],
    cost: { currency: "USD", unit: "second", estimateMinor: null },
  };
  expect(ProviderCapabilitySchema.parse(capability).pricePerSecond["720p"]).toBe(69504);
  const fallback = ProviderCapabilitySchema.parse({
    ...capability,
    maxReferenceImages: 14,
    pricePerSecond: { "360p": null, "720p": 140000, "1080p": 250000 },
  });
  expect((fallback.pricePerSecond["720p"]! * 45) / 1_000_000).toBe(6.3);
  expect(
    ProviderCapabilitySchema.safeParse({
      ...capability,
      kind: "MUSIC",
      aspects: [],
      resolutions: [],
      frameRates: [],
    }).success,
  ).toBe(true);
  expect(ProviderCapabilitySchema.safeParse({ ...capability, kind: "CRITIC" }).success).toBe(false);
  expect(
    ProviderCapabilitySchema.safeParse({
      ...capability,
      pricePerSecond: { ...capability.pricePerSecond, "720p": 0.0695 },
    }).success,
  ).toBe(false);
});
it("represents primary reserves and fallback re-estimates within the hard cap", () => {
  const budget = {
    ...base,
    runId: randomUUID(),
    currency: "USD",
    targetMinor: 600,
    hardCapMinor: 800,
    baseEstimateMinor: 500,
    reshootReserveMinor: 250,
    route: "PRIMARY",
    reservedMinor: 0,
    spentMinor: 0,
    revision: 0,
  };
  expect(BudgetEnvelopeSchema.safeParse(budget).success).toBe(true);
  expect(BudgetEnvelopeSchema.safeParse({ ...budget, baseEstimateMinor: 600 }).success).toBe(false);
  expect(
    BudgetEnvelopeSchema.safeParse({
      ...budget,
      route: "FALLBACK",
      baseEstimateMinor: 745,
      reshootReserveMinor: 0,
    }).success,
  ).toBe(true);
});
it("validates format variety, tuning bounds and mandatory safety defaults", () => {
  expect(
    FormatMixSchema.safeParse([
      { formatKey: "explainer", weight: 0.6 },
      { formatKey: "story", weight: 0.4 },
    ]).success,
  ).toBe(true);
  expect(
    FormatMixSchema.safeParse([
      { formatKey: "story", weight: 0.5 },
      { formatKey: "story", weight: 0.5 },
    ]).success,
  ).toBe(false);
  expect(FormatMixSchema.safeParse([{ formatKey: "story", weight: 0.4 }]).success).toBe(false);
  expect(
    TuningBoundsSchema.safeParse({
      formatMix: { story: { min: 0.1, max: 0.8 } },
      scoringWeights: {},
    }).success,
  ).toBe(true);
  expect(
    TuningBoundsSchema.safeParse({
      formatMix: { story: { min: 0.9, max: 0.8 } },
      scoringWeights: {},
    }).success,
  ).toBe(false);
  const guards = {
    bannedTopics: ["gambling"],
    topicsToAvoid: [],
    blockedPersonaAdvice: ["health", "legal", "finance", "political"],
    factCheckStrictness: "STRICT",
    aiDisclosure: true,
  };
  expect(GuardrailsSchema.parse(guards)).toMatchObject({
    allowRealPeople: false,
    allowBrands: false,
  });
  expect(GuardrailsSchema.safeParse({ ...guards, allowRealPeople: true }).success).toBe(false);
  expect(GuardrailsSchema.safeParse({ ...guards, aiDisclosure: false }).success).toBe(false);
});
