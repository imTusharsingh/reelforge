/** Deterministic test-only API fixtures. Never imported by application routes. */
export const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  otherWorkspace: "22222222-2222-4222-8222-222222222222",
  channel: "33333333-3333-4333-8333-333333333333",
  otherChannel: "44444444-4444-4444-8444-444444444444",
  genre: "55555555-5555-4555-8555-555555555555",
  character: "66666666-6666-4666-8666-666666666666",
  group: "77777777-7777-4777-8777-777777777777",
  series: "88888888-8888-4888-8888-888888888888",
  version: "99999999-9999-4999-8999-999999999999",
  secondVersion: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  snapshot: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  secondSnapshot: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  template: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  member: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  assignment: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};
export const channel = {
  id: ids.channel,
  workspaceId: ids.workspace,
  name: "Science studio",
  status: "ACTIVE",
  language: "en",
  handle: null,
  description: null,
  niche: "Science",
  audience: "Learners",
  timezone: "Asia/Kolkata",
  activeSnapshotId: ids.snapshot,
};
export const genre = {
  id: ids.genre,
  workspaceId: ids.workspace,
  name: "Explainers",
  audience: "Learners",
  tone: "Clear",
  language: "en",
  topicsAllowed: ["Science"],
  topicsBlocked: [],
  structure: { hook: "Question" },
  durationPreference: { minSeconds: 15, maxSeconds: 45 },
  safetyProfile: { level: "standard", requiresHumanReview: true },
};
export const series = {
  id: ids.series,
  workspaceId: ids.workspace,
  channelId: ids.channel,
  genreId: ids.genre,
  name: "Daily science",
  format: "Short",
  frequency: "Daily",
  characterGroupRefs: [],
  promptRefs: [],
};
export const profile = {
  name: "Nova",
  description: null,
  personality: { traits: ["curious"], energy: "warm" },
  voicePreference: { style: "warm" },
  visualInvariants: { palette: ["#17191C"] },
  variationRules: { allowed: ["pose"] },
};
export const character = {
  id: ids.character,
  workspaceId: ids.workspace,
  ...profile,
  status: "PUBLISHED",
  referenceAssets: [],
  activeVersionId: ids.version,
};
export const characterVersion = {
  id: ids.version,
  workspaceId: ids.workspace,
  characterId: ids.character,
  version: 1,
  status: "PUBLISHED",
  profile,
  referenceAssets: [],
  checksumSha256: "a".repeat(64),
  createdAt: "2026-11-11T10:00:00.000Z",
  publishedAt: "2026-11-11T10:00:00.000Z",
};
export const snapshot = {
  id: ids.snapshot,
  workspaceId: ids.workspace,
  channelId: ids.channel,
  version: 1,
  config: { name: channel.name },
  values: {},
  lockedFields: [],
};
export const promptVersion = {
  id: ids.version,
  workspaceId: ids.workspace,
  templateId: ids.template,
  version: 1,
  status: "PUBLISHED",
  body: {
    sections: { instructions: "Explain clearly." },
    variables: [],
    allowedAdditionSections: ["instructions"],
  },
  checksumSha256: "b".repeat(64),
};
export const promptTemplate = {
  id: ids.template,
  workspaceId: ids.workspace,
  key: "explain",
  name: "Explain",
  activeVersionId: ids.version,
  activeVersion: promptVersion,
};
export const group = {
  id: ids.group,
  workspaceId: ids.workspace,
  name: "Science cast",
  members: [
    {
      id: ids.member,
      workspaceId: ids.workspace,
      groupId: ids.group,
      characterId: ids.character,
      characterVersionId: ids.version,
      character,
      characterVersion,
    },
  ],
  assignments: [
    {
      id: ids.assignment,
      workspaceId: ids.workspace,
      groupId: ids.group,
      channelId: ids.channel,
      seriesId: null,
    },
  ],
};
