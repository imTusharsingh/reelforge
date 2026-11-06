export type IdeaInput = Readonly<{
  title: string;
  topic: string;
  hook: string;
  angle: string;
  audience: string;
  references: string[];
  sourceNotes?: string | undefined;
  expectedFormat: string;
  channelId?: string | undefined;
  seriesId?: string | undefined;
}>;

export type IdeaRecord = Readonly<{
  id: string;
  status: "DRAFT" | "BACKLOG" | "APPROVED" | "REJECTED" | "SCHEDULED";
  origin: "USER" | "AI";
  title: string;
  normalizedTitle: string;
  topic: string;
  hook: string;
  angle: string;
  audience: string;
  references: unknown;
  sourceNotes: string | null;
  expectedFormat: string;
  duplicateMatches: ReadonlyArray<{ reason: string; score: unknown; matchedIdeaId: string | null }>;
}>;

export type ApprovedIdeaSnapshot = Readonly<{
  id: string;
  ideaId: string;
  workspaceId: string;
  channelId: string | null;
  seriesId: string | null;
  topic: string;
  hook: string;
  angle: string;
  audience: string;
  references: string[];
  sourceNotes: string | null;
  expectedFormat: string;
  modelVersion: string | null;
  promptVersion: string | null;
  cost: string | null;
  costCurrency: string | null;
  checksumSha256: string;
}>;
