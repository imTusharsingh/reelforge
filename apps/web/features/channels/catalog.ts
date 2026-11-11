import type { FieldSpec } from "./model";
export const brandFields: FieldSpec[] = [
  { key: "name", label: "Channel name" },
  { key: "handle", label: "Handle", optional: true },
  { key: "description", label: "Description", optional: true },
  { key: "niche", label: "Niche", optional: true },
  { key: "language", label: "Language", optional: true },
  { key: "audience", label: "Audience", optional: true },
  {
    key: "timezone",
    label: "Timezone",
    optional: true,
    hint: "IANA timezone, for example Asia/Kolkata. Blank optional fields are omitted; this API does not support clearing them.",
  },
];
export const preferenceFields: FieldSpec[] = [
  { key: "goals", label: "Creative goals", kind: "object" },
  { key: "schedule", label: "Schedule", kind: "object" },
  { key: "automationDefaults", label: "Automation defaults", kind: "object" },
  { key: "approvalPolicy", label: "Approval policy", kind: "object" },
  {
    key: "publishingDestinations",
    label: "Publishing destination intents",
    kind: "array",
    hint: "Configuration references only. These do not connect a provider account.",
  },
];
export const genreFields: FieldSpec[] = [
  { key: "name", label: "Genre name" },
  { key: "audience", label: "Audience" },
  { key: "tone", label: "Tone" },
  { key: "language", label: "Language" },
  { key: "topicsAllowed", label: "Allowed topics", kind: "array" },
  { key: "topicsBlocked", label: "Blocked topics", kind: "array" },
  { key: "structure", label: "Story structure", kind: "object" },
  { key: "durationPreference", label: "Duration preferences", kind: "object" },
  { key: "safetyProfile", label: "Safety profile", kind: "object" },
];
export const characterFields: FieldSpec[] = [
  { key: "name", label: "Character name" },
  { key: "description", label: "Description", optional: true },
  { key: "personality", label: "Personality", kind: "object" },
  { key: "voicePreference", label: "Voice preferences", kind: "object" },
  { key: "visualInvariants", label: "Visual invariants", kind: "object" },
  { key: "variationRules", label: "Variation rules", kind: "object" },
  {
    key: "referenceAssets",
    label: "Published asset references",
    kind: "array",
    hint: 'An array of {"assetId":"…","version":1}. Published versions remain immutable.',
  },
];
export const seriesFields: FieldSpec[] = [
  { key: "name", label: "Series name" },
  { key: "format", label: "Content format" },
  { key: "frequency", label: "Frequency" },
  {
    key: "characterGroupRefs",
    label: "Character group references",
    kind: "array",
    hint: "Opaque M04 references. Assignment does not automatically synchronize these references.",
  },
  { key: "promptRefs", label: "Prompt references", kind: "array" },
];
