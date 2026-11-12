import type { WorkspaceRole } from "../../lib/api";
import { ProductionClient } from "../production/api";
import {
  parseQueue,
  parseRun,
  parseStatus,
  validateDecision,
  type Decision,
  type RenderStatus,
  type Run,
} from "./model";

export class ReviewApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly uncertain = false,
  ) {
    super(message);
  }
}
export class ReviewClient {
  public readonly production: ProductionClient;
  private busy = false;
  public suspended = false;
  private reconciled = new Set<string>();
  public constructor(
    public readonly workspaceId: string,
    public readonly role: WorkspaceRole,
    public readonly signal: AbortSignal,
  ) {
    this.production = new ProductionClient(workspaceId, role, signal);
  }
  private key(runId: string): string {
    return `reelforge:review:pending:${this.workspaceId}:${runId}`;
  }
  public uncertain(runId: string): boolean {
    try {
      return (
        typeof sessionStorage === "undefined" || sessionStorage.getItem(this.key(runId)) !== null
      );
    } catch {
      // If browser recovery storage is unavailable, fail closed before dispatch.
      return true;
    }
  }
  private async request(path: string, decision?: Decision): Promise<unknown> {
    this.signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/quality/${path}`,
        {
          method: decision ? "POST" : "GET",
          credentials: "include",
          signal: this.signal,
          headers: { "Content-Type": "application/json" },
          ...(decision ? { body: JSON.stringify(decision) } : {}),
        },
      );
    } catch {
      throw new ReviewApiError(
        0,
        decision
          ? "Decision response interrupted. Fetch persisted review state before another action."
          : "Quality service unavailable. Retry when connected.",
        Boolean(decision),
      );
    }
    if (response.status === 401 || response.status === 403) this.suspended = true;
    if (!response.ok)
      throw new ReviewApiError(
        response.status,
        response.status === 401
          ? "Session expired. Sign in again."
          : response.status === 403
            ? "Workspace access denied. Refresh your verified session."
            : response.status === 404
              ? "Review or render no longer available in this workspace."
              : response.status === 409
                ? "Review state changed or the server rejected this gate/target. Fetch persisted state before deciding again."
                : "Quality request failed. Fetch persisted state before retrying a decision.",
        Boolean(decision) && response.status >= 500,
      );
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ReviewApiError(
        502,
        "Quality service returned an unreadable response. Fetch persisted state.",
        Boolean(decision),
      );
    }
  }
  public async queue(): Promise<Run[]> {
    return parseQueue(await this.request("queue"), this.workspaceId);
  }
  public async run(runId: string): Promise<Run> {
    return parseRun(
      await this.request(`runs/${encodeURIComponent(runId)}`),
      this.workspaceId,
      runId,
    );
  }
  public async status(renderId: string): Promise<RenderStatus> {
    return parseStatus(
      await this.request(`renders/${encodeURIComponent(renderId)}/status`),
      this.workspaceId,
      renderId,
    );
  }
  public async reconcile(runId: string): Promise<Run> {
    const run = await this.run(runId);
    this.reconciled.add(runId);
    return run;
  }
  public acknowledge(runId: string): void {
    if (!this.reconciled.delete(runId)) throw new Error("Fetch persisted review state first.");
    sessionStorage.removeItem(this.key(runId));
  }
  public async decide(run: Run, decision: Decision, sceneIds: string[]): Promise<Run> {
    validateDecision(run, decision, this.role, sceneIds);
    if (this.busy || this.suspended || this.uncertain(run.id))
      throw new Error("A decision is pending or access changed. Reconcile before another action.");
    this.busy = true;
    try {
      // Store before dispatch so an unmount, reload, or interrupted response cannot
      // silently re-enable the same write. No review text is stored in the browser.
      sessionStorage.setItem(this.key(run.id), "pending");
      const payload = await this.request(`runs/${encodeURIComponent(run.id)}/decision`, decision);
      let next: Run;
      try {
        next = parseRun(payload, this.workspaceId, run.id);
        if (
          next.renderJobId !== run.renderJobId ||
          next.status !==
            (
              {
                APPROVE: "APPROVED",
                REJECT: "REJECTED",
                REQUEST_CHANGES: "CHANGES_REQUESTED",
              } as const
            )[decision.action] ||
          !next.decisions.some(
            (d) =>
              !run.decisions.some((old) => old.id === d.id) &&
              d.action === decision.action &&
              d.reason === decision.reason.trim() &&
              d.overrideReason === (decision.overrideReason?.trim() ?? null),
          )
        )
          throw new Error("Decision not confirmed.");
        if (
          decision.regeneration &&
          !next.regenerationRequests.some(
            (request) =>
              !run.regenerationRequests.some((old) => old.id === request.id) &&
              request.stage === decision.regeneration?.stage &&
              request.sceneId === (decision.regeneration.sceneId ?? null),
          )
        )
          throw new Error("Regeneration request not confirmed.");
      } catch {
        throw new ReviewApiError(
          502,
          "Decision response did not confirm saved state. Reconcile before another action.",
          true,
        );
      }
      sessionStorage.removeItem(this.key(run.id));
      return next;
    } finally {
      this.busy = false;
    }
  }
}
