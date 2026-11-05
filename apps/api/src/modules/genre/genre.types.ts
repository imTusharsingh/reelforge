import type { JsonValue } from "../channel/channel.types.js";

export type GenreInput = Readonly<{
  name: string;
  audience: string;
  tone: string;
  topicsAllowed: JsonValue;
  topicsBlocked: JsonValue;
  language: string;
  structure: JsonValue;
  durationPreference: JsonValue;
  safetyProfile: JsonValue;
}>;
export type SeriesInput = Readonly<{
  name: string;
  genreId: string;
  format: string;
  frequency: string;
  characterGroupRefs: JsonValue;
  promptRefs: JsonValue;
}>;

export const starterGenres = [
  {
    key: "educational-explainer",
    name: "Educational Explainer",
    audience: "General audience",
    tone: "Clear and curious",
    topicsAllowed: ["science", "history", "how-to"],
    topicsBlocked: ["medical advice", "political persuasion"],
    language: "en",
    structure: { opening: "hook", body: "explain", closing: "takeaway" },
    durationPreference: { minSeconds: 30, maxSeconds: 60 },
    safetyProfile: { level: "standard", requiresHumanReview: true },
  },
  {
    key: "storytime",
    name: "Storytime",
    audience: "General audience",
    tone: "Warm and playful",
    topicsAllowed: ["fiction", "folklore", "life lessons"],
    topicsBlocked: ["graphic violence", "hate"],
    language: "en",
    structure: { opening: "setup", body: "rising-action", closing: "resolution" },
    durationPreference: { minSeconds: 30, maxSeconds: 90 },
    safetyProfile: { level: "standard", requiresHumanReview: true },
  },
] as const;
