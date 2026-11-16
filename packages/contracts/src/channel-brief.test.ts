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
      targetMinor: 600,
      hardCapMinor: 800,
      dailyLimitMinor: 2000,
      monthlyLimitMinor: 18000,
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
});
