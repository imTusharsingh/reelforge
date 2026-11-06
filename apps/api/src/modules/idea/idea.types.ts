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
