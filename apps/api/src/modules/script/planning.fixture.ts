import { randomUUID } from "node:crypto";
import {
  words,
  type PlanningRequest,
  type PlanningScript,
  type ShotSpec,
} from "@reelforge/contracts";
export const context = { workspaceId: randomUUID(), userId: randomUUID(), role: "OWNER" as const };
export function planningFixture(): PlanningRequest {
  return {
    runId: randomUUID(),
    idea: "Why leaves change color",
    format: "explainer",
    brief: {
      id: randomUUID(),
      workspaceId: context.workspaceId,
      schemaVersion: "1.0",
      channelId: randomUUID(),
      version: 1,
      topic: "Trees",
      niche: "science",
      audience: "Students",
      styleBible: {
        visualStyle: "Watercolor",
        palette: ["green"],
        recurringCharacters: [],
        bannedVisuals: [],
      },
      guardrails: {
        bannedTopics: ["violence"],
        topicsToAvoid: ["gambling"],
        blockedPersonaAdvice: ["health", "legal", "finance", "political"],
        allowRealPeople: false,
        allowBrands: false,
        factCheckStrictness: "STANDARD",
        aiDisclosure: true,
      },
      formatMix: [{ formatKey: "explainer", weight: 1 }],
      tuningBounds: null,
      languages: { script: "English", narration: "English", captions: "English" },
      onCameraVoice: null,
      formatKey: "explainer",
      targetDurationSeconds: 45,
      narrationLanguage: "English",
      narratorVoice: { providerId: "gemini", voiceId: "narrator", pace: 1, language: "English" },
      requestedAutonomy: "L2",
      cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
      aiDisclosure: true,
      renderProfile: { id: "shorts", width: 1080, height: 1920, fps: 24, videoCodec: "h264" },
      budgetPolicy: {
        currency: "USD",
        targetMinor: 600,
        hardCapMinor: 800,
        dailyLimitMinor: 2000,
        monthlyLimitMinor: 18000,
      },
      references: [],
      referenceDefaults: null,
      constraints: {},
    },
  };
}
export function scriptFixture(): PlanningScript {
  const script = {
    hook: "Leaves hide a secret",
    beats: [
      "Green pigment captures sunlight.",
      "Autumn changes the light.",
      "Other colors become visible.",
    ],
    payoff: "The hidden colors were there all along.",
    cta: "Watch the trees tomorrow",
    language: "English",
    wordCount: 0,
  };
  script.wordCount = words([script.hook, ...script.beats, script.payoff, script.cta].join(" "));
  return script;
}
export function shotsFixture(request: PlanningRequest): ShotSpec[] {
  const script = scriptFixture();
  return [script.hook, ...script.beats, script.payoff, script.cta].map((voLine, ordinal) => ({
    id: randomUUID(),
    schemaVersion: "1.0",
    workspaceId: context.workspaceId,
    runId: request.runId,
    ordinal,
    version: 1,
    durationSeconds: 7.5,
    keyframePrompt: "Watercolor leaves",
    motionPrompt: "Single continuous shot, no dialogue",
    onScreenText: "",
    continuityNotes: [],
    firstFrameFrom: ordinal ? { previousShotOrdinal: ordinal - 1 } : null,
    negativePrompt: "",
    voLine,
    dialogue: "",
    camera: "wide",
    transition: "cut",
    references: [],
    width: 720,
    height: 1280,
    fps: 24,
    seed: null,
  }));
}
