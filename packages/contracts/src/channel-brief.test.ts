import { StoredChannelBriefSchema } from "./foundations.js";
import { NarratorVoiceSchema } from "./narrator-voice.js";
import { describe, expect, it } from "vitest";
import {
  BRIEF_FORMATS,
  BriefInputSchema,
  OnboardingInputSchema,
  defaultBrief,
} from "./channel-brief.js";
const input = {
  niche: "Science",
  audience: "Curious adults",
  language: "English",
  voiceId: "Kore",
  cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "Asia/Kolkata" },
};
describe("V7 Brief defaults and boundary", () => {
  it("creates the locked defaults from five inputs", () => {
    const brief = defaultBrief(input);
    expect(brief.budgetPolicy).toEqual({
      currency: "USD",
      targetMinor: 500,
      hardCapMinor: 550,
      dailyLimitMinor: 550,
      monthlyLimitMinor: 16500,
    });
    expect(brief.requestedAutonomy).toBe("L2");
    expect(brief.formatMix.map((item) => item.formatKey)).toEqual([...BRIEF_FORMATS]);
    expect(brief.tuningBounds).toBeNull();
    expect(brief.renderProfile).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 24,
      videoCodec: "h264",
    });
    expect(OnboardingInputSchema.parse({ niche: "Science", audience: "Adults" }).language).toBe(
      "English",
    );
  });
  it("rejects unknown formats, omitted formats and incomplete persona protections", () => {
    const brief = defaultBrief(input);
    expect(
      BriefInputSchema.safeParse({ ...brief, formatMix: [{ formatKey: "explainer", weight: 1 }] })
        .success,
    ).toBe(false);
    expect(BriefInputSchema.safeParse({ ...brief, formatKey: "invented" }).success).toBe(false);
    expect(
      BriefInputSchema.safeParse({
        ...brief,
        formatMix: brief.formatMix.map((item, i) =>
          i === 0 ? { ...item, formatKey: "invented" } : item,
        ),
      }).success,
    ).toBe(false);
    expect(
      BriefInputSchema.safeParse({
        ...brief,
        guardrails: { ...brief.guardrails, blockedPersonaAdvice: ["health"] },
      }).success,
    ).toBe(false);
    expect(
      BriefInputSchema.safeParse({
        ...brief,
        guardrails: {
          ...brief.guardrails,
          blockedPersonaAdvice: ["health", "health", "finance", "legal"],
        },
      }).success,
    ).toBe(false);
  });
  it("rejects identity injection and invalid cadence, budget and safety settings", () => {
    const brief = defaultBrief(input);
    for (const patch of [
      { workspaceId: "foreign" },
      { budgetPolicy: { ...brief.budgetPolicy, targetMinor: 900 } },
      { cadence: { ...brief.cadence, timezone: "invalid" } },
      { guardrails: { ...brief.guardrails, aiDisclosure: false } },
    ])
      expect(BriefInputSchema.safeParse({ ...brief, ...patch }).success).toBe(false);
  });
  it("rejects conflicting legacy narration fields", () => {
    const brief = defaultBrief({
      niche: "Science",
      audience: "Adults",
      language: "English",
      voiceId: "Kore",
      cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
    });
    expect(BriefInputSchema.safeParse({ ...brief, narrationLanguage: "French" }).success).toBe(
      false,
    );
    expect(
      BriefInputSchema.safeParse({
        ...brief,
        narratorVoice: { ...brief.narratorVoice, language: "French" },
      }).success,
    ).toBe(false);
  });
});

it.each([0.49, 3])("rejects new narrator pace %s but reads historical versions", (pace) => {
  const brief = defaultBrief(input);
  const narratorVoice = { ...brief.narratorVoice!, pace };
  expect(NarratorVoiceSchema.safeParse(narratorVoice).success).toBe(false);
  expect(BriefInputSchema.safeParse({ ...brief, narratorVoice }).success).toBe(false);
  const id = "3d1b59a3-2471-4e41-8150-a974ff02b7de";
  for (const schemaVersion of ["1.0", "1.1"]) {
    expect(
      StoredChannelBriefSchema.parse({
        ...brief,
        id,
        workspaceId: id,
        channelId: id,
        narratorVoice,
        schemaVersion,
        version: 1,
      }).narratorVoice?.pace,
    ).toBe(pace);
  }
  for (const valid of [0.5, 2])
    expect(NarratorVoiceSchema.parse({ ...narratorVoice, pace: valid }).pace).toBe(valid);
});
