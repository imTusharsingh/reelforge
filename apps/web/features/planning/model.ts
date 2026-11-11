import type { WorkspaceRole } from "../../lib/api";

export type IdeaStatus = "DRAFT" | "BACKLOG" | "APPROVED" | "REJECTED" | "SCHEDULED";
export type Idea = {
  id: string;
  workspaceId: string;
  channelId: string | null;
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
export type IdeaDraft = Pick<Idea, "title" | "topic" | "hook" | "angle" | "audience" | "expectedFormat"> & {
  channelId: string;
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
export type Script = { id: string; workspaceId: string; status: string; currentRevision: number; revisions: { revision: number; document: ScriptDocument }[] };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const string = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => string(value) && value.length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parseIdea(value: unknown, workspaceId: string): Idea {
  if (!record(value) || value.workspaceId !== workspaceId || !nonempty(value.id) ||
      !nonempty(value.title) || !nonempty(value.topic) || !nonempty(value.hook) ||
      !nonempty(value.angle) || !nonempty(value.audience) || !nonempty(value.expectedFormat) ||
      !["DRAFT", "BACKLOG", "APPROVED", "REJECTED", "SCHEDULED"].includes(String(value.status)) ||
      !(value.channelId === null || nonempty(value.channelId)) ||
      !(value.sourceNotes === null || string(value.sourceNotes)) || !strings(value.references)) {
    throw new Error("The service returned an invalid or out-of-workspace idea.");
  }
  return value as Idea;
}
export function parseScene(value: unknown): Scene {
  if (!record(value) || !nonempty(value.id) || !finite(value.startSeconds) || value.startSeconds < 0 ||
      !finite(value.durationSeconds) || value.durationSeconds <= 0 ||
      !string(value.dialogue) || !nonempty(value.visualDescription) || !nonempty(value.camera) ||
      !strings(value.audioCues) ||
      !Array.isArray(value.characterRefs) || !value.characterRefs.every(
        (ref: unknown) => record(ref) && nonempty(ref.characterId) && nonempty(ref.versionId)
      )) throw new Error("The service returned an invalid storyboard scene.");
  return value as Scene;
}
export function parseScript(value: unknown, workspaceId: string, scriptId: string): Script {
  if (!record(value) || value.workspaceId !== workspaceId || value.id !== scriptId ||
      !string(value.status) || !finite(value.currentRevision) ||
      !Array.isArray(value.revisions) || value.revisions.length !== 1) {
    throw new Error("The service returned an invalid or out-of-workspace script.");
  }
  const latest = value.revisions[0];
  if (!record(latest) || !finite(latest.revision) || !record(latest.document)) throw new Error("Invalid script revision.");
  const doc = latest.document;
  if (doc.schemaVersion !== "1.0" || !nonempty(doc.title) || !nonempty(doc.hook) ||
      !string(doc.dialogue) || !nonempty(doc.cta) || !record(doc.metadata) ||
      !nonempty(doc.metadata.genre) || !finite(doc.metadata.targetDurationSeconds) ||
      doc.metadata.targetDurationSeconds <= 0 || typeof doc.metadata.factual !== "boolean" ||
      !Array.isArray(doc.scenes) || doc.scenes.length === 0) throw new Error("Invalid script document.");
  doc.scenes.forEach(parseScene);
  return value as Script;
}
export function canWrite(role: WorkspaceRole): boolean {
  return role === "OWNER" || role === "EDITOR";
}
export function nextStatus(status: IdeaStatus): IdeaStatus[] {
  switch (status) {
    case "DRAFT": return ["BACKLOG", "APPROVED", "REJECTED"];
    case "BACKLOG": return ["APPROVED", "REJECTED"];
    case "APPROVED": return ["SCHEDULED", "REJECTED"];
    case "SCHEDULED": return ["REJECTED"];
    case "REJECTED": return ["BACKLOG"];
  }
}
export function normalizeSceneTimings(scenes: Scene[]): Scene[] {
  let start = 0;
  return scenes.map((scene) => {
    const result = { ...scene, startSeconds: start };
    start += scene.durationSeconds;
    return result;
  });
}
export function validateDocument(document: ScriptDocument): string | null {
  if (!document.title.trim() || !document.hook.trim() || !document.cta.trim() || !document.metadata.genre.trim()) return "Complete the script title, hook, CTA and genre.";
  if (!document.scenes.length) return "A script requires at least one scene.";
  if (new Set(document.scenes.map(s => s.id)).size !== document.scenes.length) return "Scene identifiers must be unique.";
  if (document.scenes.some(s => !s.visualDescription.trim() || !s.camera.trim() || !finite(s.durationSeconds) || s.durationSeconds <= 0)) return "Every scene needs visuals, camera direction and a positive duration.";
  const duration = document.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (Math.abs(duration - document.metadata.targetDurationSeconds) > 1) return "Scene duration and target duration must match within one second.";
  return null;
}
export class PlanningApiError extends Error {
  constructor(readonly status: number, message: string, readonly uncertain = false) {
    super(message);
  }
}
export class PlanningClient {
  constructor(readonly workspaceId: string, readonly role: WorkspaceRole, readonly signal: AbortSignal) {}
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    this.signal.throwIfAborted();
    if (method !== "GET" && !canWrite(this.role)) throw new PlanningApiError(403, "Owner or Editor role required.");
    let response: Response;
    try {
      response = await fetch("/api/v1/workspaces/" + encodeURIComponent(this.workspaceId) + "/" + path, {
        method, credentials: "include", signal: this.signal,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (this.signal.aborted) throw cause;
      throw new PlanningApiError(0, "Connection interrupted. Refresh server state before another save.", method !== "GET");
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = record(payload) && string(payload.message) ? payload.message : "Request failed.";
      throw new PlanningApiError(response.status, message, response.status >= 500 && method !== "GET");
    }
    if (payload === undefined) throw new PlanningApiError(502, "Invalid server response.", method !== "GET");
    return payload;
  }
  async ideas(): Promise<Idea[]> {
    const result = await this.request("ideas");
    if (!Array.isArray(result)) throw new Error("Invalid idea list.");
    return result.map(value => parseIdea(value, this.workspaceId));
  }
  async createIdea(draft: IdeaDraft): Promise<Idea> {
    return parseIdea(await this.request("ideas", "POST", draft), this.workspaceId);
  }
  async transitionIdea(idea: Idea, status: IdeaStatus, scheduledAt?: string): Promise<Idea> {
    const result = await this.request("ideas/" + encodeURIComponent(idea.id) + "/status", "PATCH", {
      status, ...(scheduledAt ? { scheduledAt } : {}),
    });
    return parseIdea(result, this.workspaceId);
  }
  async approvedIdea(ideaId: string): Promise<Record<string, unknown>> {
    const result = await this.request("ideas/approved/" + encodeURIComponent(ideaId));
    if (!record(result) || result.workspaceId !== this.workspaceId || result.ideaId !== ideaId ||
        !nonempty(result.id) || !nonempty(result.checksumSha256)) throw new Error("Invalid approved idea snapshot.");
    return result;
  }
  async script(id: string): Promise<Script> {
    return parseScript(await this.request("scripts/" + encodeURIComponent(id)), this.workspaceId, id);
  }
  async reviseScript(id: string, document: ScriptDocument): Promise<Script> {
    return parseScript(await this.request("scripts/" + encodeURIComponent(id) + "/revisions", "POST", document), this.workspaceId, id);
  }
}