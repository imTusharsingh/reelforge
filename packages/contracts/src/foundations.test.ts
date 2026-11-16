import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  autonomyPolicy,
  BudgetEnvelopeSchema,
  BudgetPolicySchema,
  ChannelBriefSchema,
  CtaSchema,
  HookSchema,
  NarratorVoiceSchema,
  ProviderCapabilitySchema,
  ReferenceAssetSchema,
  scriptWordBudget,
  VideoRunStateSchema,
} from "./index.js";

const base = { id: randomUUID(), workspaceId: randomUUID(), schemaVersion: "1.0" };
const budget = {
  currency: "USD",
  targetMinor: 600,
  hardCapMinor: 800,
  dailyLimitMinor: 2000,
  monthlyLimitMinor: 18000,
};
describe("Wave 0 contracts", () => {
  it("represents pause/recovery states and explicit first-ten autonomy", () => {
    for (const state of ["PAUSED_BUDGET", "NEEDS_HUMAN"])
      expect(VideoRunStateSchema.parse(state)).toBe(state);
    for (const requested of ["L1", "L2", "L3"] as const) {
      expect(autonomyPolicy(requested, 9)).toEqual({ effective: "L2", offerL3: false });
      expect(autonomyPolicy(requested, 10)).toEqual({
        effective: requested,
        offerL3: requested !== "L3",
      });
    }
    expect(() => autonomyPolicy("L2", -1)).toThrow();
    expect(() => autonomyPolicy("L2", 0.5)).toThrow();
  });
  it("validates the approved budget envelope in integer minor units", () => {
    expect(BudgetPolicySchema.parse(budget)).toEqual(budget);
    expect(BudgetPolicySchema.safeParse({ ...budget, targetMinor: 801 }).success).toBe(false);
    const value = {
      ...base,
      runId: randomUUID(),
      currency: "USD",
      targetMinor: 600,
      hardCapMinor: 800,
      reservedMinor: 200,
      spentMinor: 600,
      revision: 0,
    };
    expect(BudgetEnvelopeSchema.safeParse(value).success).toBe(true);
    expect(BudgetEnvelopeSchema.safeParse({ ...value, spentMinor: 601 }).success).toBe(false);
    expect(BudgetEnvelopeSchema.safeParse({ ...value, targetMinor: 900 }).success).toBe(false);
  });
  it("supports all reference kinds and sources without requiring a character", () => {
    for (const kind of ["CHARACTER", "STYLE", "SCENERY", "PROP"])
      for (const source of ["SYSTEM", "PRESET", "UPLOADED", "USER_GENERATED"]) {
        const reference = {
          ...base,
          referenceId: randomUUID(),
          kind,
          source,
          version: 1,
          name: "Tree",
          assetId: null,
          assetVersion: null,
          characterVersionId: null,
          checksumSha256: "a".repeat(64),
          rights: {
            license: "CC0-1.0",
            rightsHolder: "Fixture",
            attestedAt: new Date().toISOString(),
          },
          metadata: {},
          createdAt: new Date().toISOString(),
        };
        expect(ReferenceAssetSchema.safeParse(reference).success).toBe(true);
        expect(
          ReferenceAssetSchema.safeParse({ ...reference, assetId: randomUUID() }).success,
        ).toBe(false);
      }
  });
  it("validates brief timezone and optional narrator", () => {
    const brief = {
      ...base,
      channelId: randomUUID(),
      version: 1,
      topic: "Trees",
      audience: "Everyone",
      formatKey: "explainer",
      targetDurationSeconds: 30,
      narrationLanguage: "English",
      narratorVoice: null,
      requestedAutonomy: "L2",
      cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "Asia/Kolkata" },
      aiDisclosure: true,
      renderProfile: { id: "vertical", width: 1080, height: 1920, fps: 24, videoCodec: "h264" },
      budgetPolicy: budget,
      references: [],
      constraints: {},
    };
    expect(ChannelBriefSchema.safeParse(brief).success).toBe(true);
    expect(
      ChannelBriefSchema.safeParse({ ...brief, cadence: { ...brief.cadence, timezone: "invalid" } })
        .success,
    ).toBe(false);
    expect(NarratorVoiceSchema.parse({ providerId: "fixture", voiceId: "narrator" }).language).toBe(
      "English",
    );
  });
  it("rejects inverted provider duration ranges", () => {
    const capability = {
      ...base,
      providerId: "fixture",
      modelId: "v1",
      kind: "VIDEO",
      enabled: false,
      supportsReferenceImages: true,
      supportsAudio: true,
      asynchronous: true,
      polling: true,
      minDurationSeconds: 1,
      maxDurationSeconds: 8,
      resolutions: [{ width: 720, height: 1280 }],
      frameRates: [24],
      regions: [],
      cost: { currency: "USD", unit: "second", estimateMinor: null },
    };
    expect(ProviderCapabilitySchema.safeParse(capability).success).toBe(true);
    expect(
      ProviderCapabilitySchema.safeParse({ ...capability, minDurationSeconds: 9 }).success,
    ).toBe(false);
  });
  it("enforces word boundaries and speech duration for aggregate and scene copy", () => {
    expect(HookSchema.safeParse(" \n ").success).toBe(false);
    expect(HookSchema.safeParse(Array(20).fill("word").join(" ")).success).toBe(true);
    expect(HookSchema.safeParse(Array(21).fill("word").join(" ")).success).toBe(false);
    expect(CtaSchema.safeParse(Array(15).fill("word").join(" ")).success).toBe(true);
    expect(CtaSchema.safeParse(Array(16).fill("word").join(" ")).success).toBe(false);
    const script = {
      hook: "Look here",
      cta: "Follow",
      dialogue: "",
      metadata: { targetDurationSeconds: 2 },
      scenes: [{ dialogue: "", narration: "Two leaves" }],
    };
    expect(scriptWordBudget(script)).toBe(true);
    expect(scriptWordBudget({ ...script, scenes: [], narration: "Two leaves" })).toBe(true);
    expect(
      scriptWordBudget({
        ...script,
        dialogue: "one two three four five six seven eight",
        scenes: [],
      }),
    ).toBe(false);
  });
});
