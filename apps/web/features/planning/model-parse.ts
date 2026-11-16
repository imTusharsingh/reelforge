import type {
  Idea,
  Scene,
  Script,
  Revision,
  ScriptDocument,
  Page,
  ApprovedScriptExport,
} from "./model-types";
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export const string = (value: unknown): value is string => typeof value === "string";
export const nonempty = (value: unknown): value is string => string(value) && value.length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function parseIdea(value: unknown, workspaceId: string): Idea {
  if (
    !record(value) ||
    value.workspaceId !== workspaceId ||
    !nonempty(value.id) ||
    !nonempty(value.title) ||
    !nonempty(value.topic) ||
    !nonempty(value.hook) ||
    !nonempty(value.angle) ||
    !nonempty(value.audience) ||
    !nonempty(value.expectedFormat) ||
    !["DRAFT", "BACKLOG", "APPROVED", "REJECTED", "SCHEDULED"].includes(String(value.status)) ||
    !(value.channelId === null || nonempty(value.channelId)) ||
    !(value.seriesId === null || nonempty(value.seriesId)) ||
    !nonempty(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !(
      value.archivedAt === null ||
      (string(value.archivedAt) && Number.isFinite(Date.parse(value.archivedAt)))
    ) ||
    !(
      value.scheduledAt === null ||
      (string(value.scheduledAt) && Number.isFinite(Date.parse(value.scheduledAt)))
    ) ||
    !(value.sourceNotes === null || string(value.sourceNotes)) ||
    !strings(value.references) ||
    (value.duplicateMatches !== undefined &&
      (!Array.isArray(value.duplicateMatches) ||
        !value.duplicateMatches.every(
          (match: unknown) =>
            record(match) &&
            string(match.reason) &&
            (match.matchedIdeaId === null || nonempty(match.matchedIdeaId)),
        )))
  ) {
    throw new Error("The service returned an invalid or out-of-workspace idea.");
  }
  return value as Idea;
}
function parseScene(value: unknown): Scene {
  if (
    !record(value) ||
    !nonempty(value.id) ||
    !finite(value.startSeconds) ||
    value.startSeconds < 0 ||
    !finite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    !string(value.dialogue) ||
    !nonempty(value.visualDescription) ||
    !nonempty(value.camera) ||
    !strings(value.audioCues) ||
    !Array.isArray(value.characterRefs) ||
    !value.characterRefs.every(
      (ref: unknown) => record(ref) && nonempty(ref.characterId) && nonempty(ref.versionId),
    )
  )
    throw new Error("The service returned an invalid storyboard scene.");
  if (value.narration !== undefined && !string(value.narration))
    throw new Error("Invalid scene narration.");
  if (value.transition !== undefined && !string(value.transition))
    throw new Error("Invalid scene transition.");
  return value as Scene;
}
export function parseScript(value: unknown, workspaceId: string, scriptId: string): Script {
  if (
    !record(value) ||
    value.workspaceId !== workspaceId ||
    value.id !== scriptId ||
    !["DRAFT", "REVISION_PENDING", "APPROVED", "REJECTED"].includes(String(value.status)) ||
    !Number.isSafeInteger(value.currentRevision) ||
    Number(value.currentRevision) < 1 ||
    !Array.isArray(value.revisions) ||
    value.revisions.length !== 1
  ) {
    throw new Error("The service returned an invalid or out-of-workspace script.");
  }
  const latest = value.revisions[0];
  if (!record(latest) || !finite(latest.revision) || !record(latest.document))
    throw new Error("Invalid script revision.");
  if (latest.revision !== value.currentRevision)
    throw new Error("Revision does not match current script.");
  parseDocument(latest.document);
  return value as Script;
}
export function parseApprovedExport(
  value: unknown,
  scriptId: string,
  expectedRevision?: number,
): ApprovedScriptExport {
  if (
    !record(value) ||
    value.scriptId !== scriptId ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    (expectedRevision !== undefined && value.revision !== expectedRevision) ||
    !nonempty(value.approvedIdeaSnapshotId)
  )
    throw new Error("Invalid approved script export.");
  return {
    scriptId,
    revision: Number(value.revision),
    approvedIdeaSnapshotId: value.approvedIdeaSnapshotId,
    document: parseDocument(value.document),
  };
}
export function parseDocument(value: unknown): ScriptDocument {
  if (!record(value)) throw new Error("Invalid script document.");
  const doc = value;
  if (
    doc.schemaVersion !== "1.0" ||
    !nonempty(doc.title) ||
    !nonempty(doc.hook) ||
    !string(doc.dialogue) ||
    !nonempty(doc.cta) ||
    !record(doc.metadata) ||
    !nonempty(doc.metadata.genre) ||
    !finite(doc.metadata.targetDurationSeconds) ||
    doc.metadata.targetDurationSeconds <= 0 ||
    typeof doc.metadata.factual !== "boolean" ||
    !Array.isArray(doc.scenes) ||
    doc.scenes.length === 0
  )
    throw new Error("Invalid script document.");
  doc.scenes.forEach(parseScene);
  if (doc.narration !== undefined && !string(doc.narration)) throw new Error("Invalid narration.");
  if (
    doc.claims !== undefined &&
    (!Array.isArray(doc.claims) ||
      !doc.claims.every(
        (c) =>
          record(c) && nonempty(c.text) && string(c.sourceUrl) && /^https?:\/\//.test(c.sourceUrl),
      ))
  )
    throw new Error("Invalid claims.");
  return doc as ScriptDocument;
}
export function parseRevision(value: unknown): Revision {
  if (!record(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1)
    throw new Error("Invalid persisted revision.");
  const document = parseDocument(value.document);
  if (
    value.createdAt !== undefined &&
    (!string(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)))
  )
    throw new Error("Invalid revision timestamp.");
  return { ...value, revision: Number(value.revision), document };
}
export function parsePage<T>(value: unknown, parse: (v: unknown) => T, page: number): Page<T> {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    !(
      value.nextPage === null ||
      (Number.isSafeInteger(value.nextPage) && Number(value.nextPage) > page)
    )
  )
    throw new Error("Invalid script page.");
  return { items: value.items.map(parse), nextPage: value.nextPage as number | null };
}
