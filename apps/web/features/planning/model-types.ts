export type IdeaStatus = "DRAFT" | "BACKLOG" | "APPROVED" | "REJECTED" | "SCHEDULED";
export type Idea = {
  id: string;
  workspaceId: string;
  channelId: string | null;
  seriesId: string | null;
  updatedAt: string;
  archivedAt: string | null;
  scheduledAt: string | null;
  duplicateMatches?: { reason: string; score: unknown; matchedIdeaId: string | null }[];
  title: string;
  topic: string;
  hook: string;
  angle: string;
  audience: string;
  expectedFormat: string;
  status: IdeaStatus;
  sourceNotes: string | null;
  references: string[];
};
export type IdeaDraft = Pick<
  Idea,
  "title" | "topic" | "hook" | "angle" | "audience" | "expectedFormat"
> & {
  channelId: string;
  seriesId: string;
  sourceNotes: string;
  references: string[];
};
export type Scene = {
  id: string;
  startSeconds: number;
  durationSeconds: number;
  characterRefs: { characterId: string; versionId: string }[];
  dialogue: string;
  narration?: string;
  visualDescription: string;
  camera: string;
  audioCues: string[];
  transition?: string;
};
export type ScriptDocument = {
  schemaVersion: "1.0";
  title: string;
  hook: string;
  dialogue: string;
  narration?: string;
  cta: string;
  metadata: { genre: string; targetDurationSeconds: number; factual: boolean };
  scenes: Scene[];
  claims?: { text: string; sourceUrl: string }[];
};
export type Revision = {
  id?: string;
  revision: number;
  document: ScriptDocument;
  createdAt?: string;
  modelVersion?: string | null;
  promptVersion?: string | null;
};
export type Page<T> = { items: T[]; nextPage: number | null };
export type Script = {
  id: string;
  workspaceId: string;
  status: string;
  currentRevision: number;
  revisions: Revision[];
};

export type ApprovedScriptExport = {
  scriptId: string;
  revision: number;
  approvedIdeaSnapshotId: string;
  document: ScriptDocument;
};
export type ApprovedIdea = {
  id: string;
  ideaId: string;
  workspaceId: string;
  checksumSha256: string;
  channelId?: string | null;
  seriesId?: string | null;
};
export type GenerationInput = {
  approvedIdeaSnapshotId: string;
  approvedIdeaChecksum: string;
  configSnapshotId: string;
  promptSnapshotId: string;
  prompt: string;
  channelId?: string;
};
export type SaveReconciliation = { resource: string; snapshot: unknown };
