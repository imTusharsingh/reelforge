import { scriptRequestIdentity, finishScriptRequest } from "./script-request";
import type { WorkspaceRole } from "../../lib/api";
import { csrfFailureMessage, withCsrf } from "../../lib/csrf";
import type {
  IdeaStatus,
  Idea,
  IdeaDraft,
  Script,
  Revision,
  Page,
  ApprovedIdea,
  GenerationInput,
  ApprovedScriptExport,
  SaveReconciliation,
  ScriptDocument,
} from "./model-types";
import {
  record,
  string,
  nonempty,
  parseIdea,
  parseScript,
  parseRevision,
  parsePage,
  parseApprovedExport,
} from "./model-parse";
import { canWrite, nextStatus, validateDocument, ideaPayload, draftFromIdea } from "./model-edit";
import { pendingSave, clearPendingSave, readPendingMarker, markPendingSave } from "./model-pending";
export type * from "./model-types";
export {
  record,
  parseIdea,
  parseScript,
  parseDocument,
  parseRevision,
  parsePage,
} from "./model-parse";
export * from "./model-edit";
export { pendingSave, clearPendingSave } from "./model-pending";
/** @deprecated M06/M24 manual idea approval and planning edit replaced by V10 scoring + V8 read-only detail; removed in T2, L1 retains approvals. See DEPRECATIONS.md. */
export class PlanningApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
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
        withCsrf({
          method,
          credentials: "include",
          cache: "no-store",
          signal: this.signal,
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
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
      const csrfMessage = csrfFailureMessage(payload);
      if (response.status === 401 || (response.status === 403 && !csrfMessage)) this.accessDenied();
      const message =
        csrfMessage ??
        (record(payload) && string(payload.message) ? payload.message : "Request failed.");
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
    if (activeWrites.has(this.workspaceId))
      throw new PlanningApiError(409, "Wait for the active save to finish.");
    markPendingSave(this.workspaceId, path);
    activeWrites.add(this.workspaceId);
    try {
      const value = parse(await this.request(path, method, body));
      clearPendingSave(this.workspaceId);
      return value;
    } catch (error) {
      if (error instanceof PlanningApiError && error.status >= 400 && error.status < 500)
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
    const identity = await scriptRequestIdentity(this.workspaceId, [
      input.approvedIdeaSnapshotId,
      input.approvedIdeaChecksum,
      input.configSnapshotId,
      input.promptSnapshotId,
      input.prompt,
      input.channelId ?? null,
    ]);
    const saved = await this.write(
      "scripts",
      "POST",
      { ...input, correlationId: identity.correlationId },
      (result) => {
        if (!record(result) || !string(result.id))
          throw new Error("Invalid generated script response.");
        return parseScript(result, this.workspaceId, result.id);
      },
    );
    finishScriptRequest(identity.key);
    return saved;
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
