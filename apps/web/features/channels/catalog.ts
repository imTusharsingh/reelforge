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
  {
    key: "schedule",
    label: "Schedule",
    kind: "object",
    common: [
      { key: "frequency", label: "Schedule frequency", choices: ["DAILY", "WEEKLY"] },
      { key: "time", label: "Local run time", kind: "time" },
      { key: "timezone", label: "Schedule timezone" },
      { key: "maxRunsPerDay", label: "Maximum runs per day", kind: "number" },
    ],
    hint: "Weekly days, multiple slots and workflow inputs remain available under Advanced. Scheduling still requires the worker and budget/safety gates.",
  },
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
  { key: "topicsAllowed", label: "Allowed topics", kind: "lines", hint: "One topic per line" },
  { key: "topicsBlocked", label: "Blocked topics", kind: "lines", hint: "One topic per line" },
  { key: "structure", label: "Story structure", kind: "object" },
  {
    key: "durationPreference",
    label: "Duration preferences",
    kind: "object",
    common: [
      { key: "minSeconds", label: "Minimum duration (seconds)", kind: "number" },
      { key: "maxSeconds", label: "Maximum duration (seconds)", kind: "number" },
    ],
  },
  {
    key: "safetyProfile",
    label: "Safety profile",
    kind: "object",
    common: [
      { key: "level", label: "Safety level" },
      { key: "requiresHumanReview", label: "Require human review", kind: "boolean" },
    ],
  },
];
export const characterFields: FieldSpec[] = [
  { key: "name", label: "Character name" },
  { key: "description", label: "Description", optional: true },
  {
    key: "personality",
    label: "Personality",
    kind: "object",
    common: [{ key: "traits", label: "Personality traits", kind: "lines" }],
  },
  {
    key: "voicePreference",
    label: "Voice preferences",
    kind: "object",
    common: [{ key: "style", label: "Voice style preference" }],
  },
  {
    key: "visualInvariants",
    label: "Visual invariants",
    kind: "object",
    common: [{ key: "palette", label: "Color palette", kind: "lines" }],
  },
  {
    key: "variationRules",
    label: "Variation rules",
    kind: "object",
    common: [{ key: "allowed", label: "Allowed variations", kind: "lines" }],
  },
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
