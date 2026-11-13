import type { WorkspaceRole } from "../../lib/api";

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

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const string = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => string(value) && value.length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const finite = (value: unknown): value is number =>
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
export function parseScene(value: unknown): Scene {
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
export function canWrite(role: WorkspaceRole): boolean {
  return role === "OWNER" || role === "EDITOR";
}
export function nextStatus(status: IdeaStatus): IdeaStatus[] {
  switch (status) {
    case "DRAFT":
      return ["BACKLOG", "APPROVED", "REJECTED"];
    case "BACKLOG":
      return ["APPROVED", "REJECTED"];
    case "APPROVED":
      return ["SCHEDULED", "REJECTED"];
    case "SCHEDULED":
      return ["REJECTED"];
    case "REJECTED":
      return ["BACKLOG"];
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
  if (
    !document.title.trim() ||
    !document.hook.trim() ||
    !document.cta.trim() ||
    !document.metadata.genre.trim()
  )
    return "Complete the script title, hook, CTA and genre.";
  if (!document.scenes.length) return "A script requires at least one scene.";
  if (new Set(document.scenes.map((s) => s.id)).size !== document.scenes.length)
    return "Scene identifiers must be unique.";
  if (
    document.scenes.some(
      (s) =>
        !s.visualDescription.trim() ||
        !s.camera.trim() ||
        !finite(s.durationSeconds) ||
        s.durationSeconds <= 0,
    )
  )
    return "Every scene needs visuals, camera direction and a positive duration.";
  if (document.scenes.some((s) => !finite(s.startSeconds) || s.startSeconds < 0))
    return "Scene start times must be non-negative.";
  if (
    !finite(document.metadata.targetDurationSeconds) ||
    document.metadata.targetDurationSeconds <= 0
  )
    return "Target duration must be a positive finite number.";
  if (
    document.claims?.some((c) => {
      try {
        return !c.text.trim() || !["https:", "http:"].includes(new URL(c.sourceUrl).protocol);
      } catch {
        return true;
      }
    })
  )
    return "Claims need text and a valid HTTP or HTTPS source URL.";
  let expectedStart = 0;
  for (const scene of document.scenes) {
    if (Math.abs(scene.startSeconds - expectedStart) > 0.000001)
      return "This storyboard uses sequential scenes without gaps or overlaps. Use Reflow scene starts to align the draft before saving.";
    expectedStart += scene.durationSeconds;
  }
  const refs = document.scenes.flatMap((s) => s.characterRefs.map((r) => r.versionId));
  if (new Set(refs).size !== refs.length)
    return "The current service accepts a character version only once per script. Remove repeated assignments before saving.";
  const duration = document.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (Math.abs(duration - document.metadata.targetDurationSeconds) > 1)
    return "Scene duration and target duration must match within one second.";
  return null;
}
export class PlanningApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}
export type ApprovedScriptExport = {
  scriptId: string;
  revision: number;
  approvedIdeaSnapshotId: string;
  document: ScriptDocument;
};
function parseApprovedExport(
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
function ideaReconciliationState(idea: Idea): unknown {
  return {
    ...draftFromIdea(idea),
    id: idea.id,
    status: idea.status,
    updatedAt: idea.updatedAt,
    archivedAt: idea.archivedAt,
    scheduledAt: idea.scheduledAt,
  };
}
function scriptReconciliationState(script: Script): unknown {
  return {
    id: script.id,
    status: script.status,
    currentRevision: script.currentRevision,
    revisions: script.revisions.map(({ revision, document }) => ({ revision, document })),
  };
}
export type SaveReconciliation = { resource: string; snapshot: unknown };
const activeWrites = new Set<string>();
export class PlanningClient {
  constructor(
    readonly workspaceId: string,
    readonly role: WorkspaceRole,
    readonly signal: AbortSignal,
    readonly accessDenied: () => void = () => {},
  ) {}
  private readonly reconciliations = new WeakMap<SaveReconciliation, string>();
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    this.signal.throwIfAborted();
    if (method !== "GET" && !canWrite(this.role))
      throw new PlanningApiError(403, "Owner or Editor role required.");
    let response: Response;
    try {
      response = await fetch(
        "/api/v1/workspaces/" + encodeURIComponent(this.workspaceId) + "/" + path,
        {
          method,
          credentials: "include",
          cache: "no-store",
          signal: this.signal,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch (cause) {
      if (this.signal.aborted) throw cause;
      throw new PlanningApiError(
        0,
        "Connection interrupted. Refresh server state before another save.",
        method !== "GET",
      );
    }
    const payload: unknown = await response.json().catch(() => undefined);
    this.signal.throwIfAborted();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.accessDenied();
      const message =
        record(payload) && string(payload.message) ? payload.message : "Request failed.";
      throw new PlanningApiError(
        response.status,
        message,
        response.status >= 500 && method !== "GET",
      );
    }
    if (payload === undefined)
      throw new PlanningApiError(502, "Invalid server response.", method !== "GET");
    return payload;
  }
  private async write<T>(
    path: string,
    method: string,
    body: unknown,
    parse: (v: unknown) => T,
  ): Promise<T> {
    if (!canWrite(this.role)) throw new PlanningApiError(403, "Owner or Editor role required.");
    this.signal.throwIfAborted();
    if (pendingSave(this.workspaceId))
      throw new PlanningApiError(409, "Reconcile the earlier save before sending another change.");
    markPendingSave(this.workspaceId, path);
    activeWrites.add(this.workspaceId);
    try {
      const value = parse(await this.request(path, method, body));
      clearPendingSave(this.workspaceId);
      return value;
    } catch (error) {
      if (
        path !== "scripts" &&
        error instanceof PlanningApiError &&
        error.status >= 400 &&
        error.status < 500
      )
        clearPendingSave(this.workspaceId);
      throw error;
    } finally {
      activeWrites.delete(this.workspaceId);
    }
  }
  async ideas(status?: IdeaStatus, includeArchived = false): Promise<Idea[]> {
    const query = new URLSearchParams({ includeArchived: String(includeArchived) });
    if (status) query.set("status", status);
    const result = await this.request("ideas?" + query);
    if (!Array.isArray(result)) throw new Error("Invalid idea list.");
    return result.map((value) => parseIdea(value, this.workspaceId));
  }
  async idea(id: string): Promise<Idea> {
    const idea = (await this.ideas(undefined, true)).find((i) => i.id === id);
    if (!idea) throw new PlanningApiError(404, "Idea is unavailable in this workspace.");
    return idea;
  }
  async createIdea(draft: IdeaDraft): Promise<Idea> {
    return this.write("ideas", "POST", ideaPayload(draft), (v) => parseIdea(v, this.workspaceId));
  }
  async editIdea(idea: Idea, draft: IdeaDraft): Promise<Idea> {
    return this.write(
      `ideas/${encodeURIComponent(idea.id)}`,
      "PATCH",
      { ...ideaPayload(draft), expectedUpdatedAt: idea.updatedAt },
      (v) => parseIdea(v, this.workspaceId),
    );
  }
  async archiveIdea(idea: Idea, restore = false): Promise<Idea> {
    return this.write(
      `ideas/${encodeURIComponent(idea.id)}${restore ? "/restore" : "/archive"}`,
      "POST",
      { expectedUpdatedAt: idea.updatedAt },
      (v) => parseIdea(v, this.workspaceId),
    );
  }
  async transitionIdea(idea: Idea, status: IdeaStatus, scheduledAt?: string): Promise<Idea> {
    if (!nextStatus(idea.status).includes(status))
      throw new Error("This idea status transition is not allowed.");
    await this.write(
      `ideas/${encodeURIComponent(idea.id)}/status`,
      "PATCH",
      {
        status,
        expectedStatus: idea.status,
        expectedUpdatedAt: idea.updatedAt,
        ...(scheduledAt ? { scheduledAt } : {}),
      },
      (value) => parseIdea(value, this.workspaceId),
    );
    // Approval/scheduling acknowledgements include the immutable snapshot but not the new timestamp.
    return this.idea(idea.id);
  }
  async approvedIdea(ideaId: string): Promise<ApprovedIdea | null> {
    let result: unknown;
    try {
      result = await this.request(`ideas/approved/${encodeURIComponent(ideaId)}`);
    } catch (e) {
      if (e instanceof PlanningApiError && e.status === 404) return null;
      throw e;
    }
    if (
      !record(result) ||
      result.workspaceId !== this.workspaceId ||
      result.ideaId !== ideaId ||
      !nonempty(result.id) ||
      !nonempty(result.checksumSha256)
    )
      throw new Error("Invalid approved idea snapshot.");
    return result as ApprovedIdea;
  }
  async scripts(page = 1): Promise<Page<Script>> {
    return parsePage(
      await this.request(`scripts?page=${page}`),
      (v) => {
        if (!record(v) || !string(v.id)) throw new Error("Invalid script.");
        return parseScript(v, this.workspaceId, v.id);
      },
      page,
    );
  }
  async history(id: string, page = 1): Promise<Page<Revision>> {
    return parsePage(
      await this.request(`scripts/${encodeURIComponent(id)}/revisions?page=${page}`),
      parseRevision,
      page,
    );
  }
  async script(id: string): Promise<Script> {
    return parseScript(
      await this.request(`scripts/${encodeURIComponent(id)}`),
      this.workspaceId,
      id,
    );
  }
  async reviseScript(base: Script, document: ScriptDocument): Promise<Script> {
    if (base.status === "APPROVED") throw new Error("Approved scripts are immutable.");
    const validation = validateDocument(document);
    if (validation) throw new Error(validation);
    return this.write(
      `scripts/${encodeURIComponent(base.id)}/revisions`,
      "POST",
      {
        expectedRevision: base.currentRevision,
        document,
      },
      (value) => {
        const saved = parseScript(value, this.workspaceId, base.id);
        if (saved.currentRevision !== base.currentRevision + 1)
          throw new Error("Unexpected saved script revision. Reconcile server state.");
        return saved;
      },
    );
  }
  async approveScript(base: Script): Promise<Script> {
    if (base.status === "APPROVED") throw new Error("This script is already approved.");
    await this.write(
      `scripts/${encodeURIComponent(base.id)}/approve`,
      "POST",
      {
        expectedRevision: base.currentRevision,
      },
      (value) => parseApprovedExport(value, base.id, base.currentRevision),
    );
    const saved = await this.script(base.id);
    if (saved.status !== "APPROVED" || saved.currentRevision !== base.currentRevision)
      throw new Error(
        "Approval acknowledged. Refresh the approved server state before continuing.",
      );
    return saved;
  }
  async exportScript(id: string, expectedRevision: number): Promise<ApprovedScriptExport> {
    return parseApprovedExport(
      await this.request(`scripts/${encodeURIComponent(id)}/export`),
      id,
      expectedRevision,
    );
  }
  async reconcilePendingSave(): Promise<SaveReconciliation> {
    const marker = readPendingMarker(this.workspaceId);
    const path = pendingSave(this.workspaceId);
    if (!marker || !path || activeWrites.has(this.workspaceId))
      throw new Error("Wait for the active save to finish before reconciliation.");
    let snapshot: unknown;
    let resource: string;
    if (path === "ideas") {
      resource = "Idea library including archives (the interrupted create has no confirmed ID)";
      snapshot = (await this.ideas(undefined, true)).map(ideaReconciliationState);
    } else if (/^ideas\/[^/]+(?:\/(?:restore|status))?$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[1]!);
      resource = `Idea ${id}`;
      snapshot = ideaReconciliationState(await this.idea(id));
    } else if (/^scripts\/[^/]+\/(?:revisions|approve)$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[1]!);
      resource = `Script ${id}`;
      snapshot = scriptReconciliationState(await this.script(id));
    } else if (path === "scripts") {
      resource = "Script library (the interrupted create has no confirmed ID)";
      const items: Script[] = [];
      let page: number | null = 1;
      while (page !== null) {
        if (page > 10000) throw new Error("Script library exceeds the reconciliation page limit.");
        const result: Page<Script> = await this.scripts(page);
        items.push(...result.items);
        page = result.nextPage;
      }
      snapshot = items.map(scriptReconciliationState);
    } else
      throw new Error("Unknown interrupted operation. Keep writes blocked and contact support.");
    this.signal.throwIfAborted();
    if (marker !== readPendingMarker(this.workspaceId) || activeWrites.has(this.workspaceId))
      throw new Error("The pending operation changed. Fetch the affected resource again.");
    const reconciliation = { resource, snapshot };
    this.reconciliations.set(reconciliation, marker);
    return reconciliation;
  }
  acknowledgePendingSave(reconciliation: SaveReconciliation): void {
    this.signal.throwIfAborted();
    const marker = this.reconciliations.get(reconciliation);
    if (
      !marker ||
      marker !== readPendingMarker(this.workspaceId) ||
      activeWrites.has(this.workspaceId)
    )
      throw new Error(
        "Fetch and compare the current affected resource before clearing the pending save.",
      );
    this.reconciliations.delete(reconciliation);
    clearPendingSave(this.workspaceId);
  }
  async generateScript(input: GenerationInput): Promise<Script> {
    return this.write("scripts", "POST", input, (result) => {
      if (!record(result) || !string(result.id))
        throw new Error("Invalid generated script response.");
      return parseScript(result, this.workspaceId, result.id);
    });
  }
  async objects(path: string): Promise<Record<string, unknown>[]> {
    const value = await this.request(path);
    if (!Array.isArray(value) || !value.every((row: unknown) => record(row) && nonempty(row.id)))
      throw new Error("Invalid resource list.");
    for (const row of value)
      if (row.workspaceId !== undefined && row.workspaceId !== this.workspaceId)
        throw new Error("Foreign workspace resource.");
    return value;
  }
}
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
export function ideaPayload(draft: IdeaDraft): Record<string, unknown> {
  for (const field of ["title", "topic", "hook", "angle", "audience", "expectedFormat"] as const)
    if (!draft[field].trim()) throw new Error(`Complete ${field}.`);
  if (!draft.channelId && !draft.seriesId) throw new Error("Select a channel or series.");
  return {
    title: draft.title.trim(),
    topic: draft.topic.trim(),
    hook: draft.hook.trim(),
    angle: draft.angle.trim(),
    audience: draft.audience.trim(),
    expectedFormat: draft.expectedFormat.trim(),
    references: draft.references.map((reference) => reference.trim()).filter(Boolean),
    sourceNotes: draft.sourceNotes,
    ...(draft.channelId ? { channelId: draft.channelId } : {}),
    ...(draft.seriesId ? { seriesId: draft.seriesId } : {}),
  };
}
export function draftFromIdea(idea: Idea): IdeaDraft {
  return {
    title: idea.title,
    topic: idea.topic,
    hook: idea.hook,
    angle: idea.angle,
    audience: idea.audience,
    expectedFormat: idea.expectedFormat,
    references: [...idea.references],
    sourceNotes: idea.sourceNotes ?? "",
    channelId: idea.channelId ?? "",
    seriesId: idea.seriesId ?? "",
  };
}
export function patchScene(
  document: ScriptDocument,
  id: string,
  patch: Partial<Scene>,
): ScriptDocument {
  return {
    ...document,
    scenes: document.scenes.map((scene) =>
      scene.id === id ? { ...scene, ...patch, id: scene.id } : scene,
    ),
  };
}
export function moveScene(document: ScriptDocument, id: string, offset: number): ScriptDocument {
  const scenes = [...document.scenes];
  const index = scenes.findIndex((s) => s.id === id);
  const destination = index + offset;
  if (index < 0 || destination < 0 || destination >= scenes.length) return document;
  [scenes[index], scenes[destination]] = [scenes[destination]!, scenes[index]!];
  return { ...document, scenes: normalizeSceneTimings(scenes) };
}
export function mergeRevision(
  base: ScriptDocument,
  local: ScriptDocument,
  remote: ScriptDocument,
): ScriptDocument {
  const result = structuredClone(remote);
  const b = base.scenes.map((s) => s.id).join();
  const l = local.scenes.map((s) => s.id).join();
  const r = remote.scenes.map((s) => s.id).join();
  if (l !== b && r !== b && l !== r)
    throw new Error("Both editors changed scene order. Compare manually.");
  const localChanged = new Map(
    local.scenes
      .filter((s) => JSON.stringify(s) !== JSON.stringify(base.scenes.find((v) => v.id === s.id)))
      .map((s) => [s.id, s]),
  );
  for (const [id, scene] of localChanged) {
    const prior = base.scenes.find((s) => s.id === id),
      server = remote.scenes.find((s) => s.id === id);
    if (
      JSON.stringify(server) !== JSON.stringify(prior) &&
      JSON.stringify(server) !== JSON.stringify(scene)
    )
      throw new Error(`Scene ${id} changed in both drafts. Compare manually.`);
  }
  if (l !== b && r === b)
    result.scenes = local.scenes.map(
      (s) => localChanged.get(s.id) ?? remote.scenes.find((v) => v.id === s.id) ?? s,
    );
  else result.scenes = remote.scenes.map((s) => localChanged.get(s.id) ?? s);
  for (const key of [
    "title",
    "hook",
    "dialogue",
    "narration",
    "cta",
    "metadata",
    "claims",
  ] as const) {
    if (JSON.stringify(local[key]) !== JSON.stringify(base[key])) {
      if (
        JSON.stringify(remote[key]) !== JSON.stringify(base[key]) &&
        JSON.stringify(remote[key]) !== JSON.stringify(local[key])
      )
        throw new Error(`${key} changed in both drafts.`);
      Object.assign(result, { [key]: local[key] });
    }
  }
  return result;
}

const pendingMemory = new Map<string, string>();
const pendingKey = (workspaceId: string): string => `reelforge.planning.pending:${workspaceId}`;
function readPendingMarker(workspaceId: string): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : (sessionStorage.getItem(pendingKey(workspaceId)) ?? pendingMemory.get(workspaceId) ?? null);
  } catch {
    return pendingMemory.get(workspaceId) ?? null;
  }
}
export function pendingSave(workspaceId: string): string | null {
  const marker = readPendingMarker(workspaceId);
  if (!marker) return null;
  try {
    const parsed: unknown = JSON.parse(marker);
    return record(parsed) && string(parsed.path) ? parsed.path : marker;
  } catch {
    return marker;
  }
}
function markPendingSave(workspaceId: string, path: string): void {
  const marker = JSON.stringify({ path, nonce: crypto.randomUUID() });
  if (typeof window !== "undefined") pendingMemory.set(workspaceId, marker);
  try {
    if (typeof window !== "undefined") sessionStorage.setItem(pendingKey(workspaceId), marker);
  } catch {
    /* Requests are never automatically replayed. */
  }
}
export function clearPendingSave(workspaceId: string): void {
  pendingMemory.delete(workspaceId);
  try {
    if (typeof window !== "undefined") sessionStorage.removeItem(pendingKey(workspaceId));
  } catch {
    /* No request bodies or credentials are stored. */
  }
}
