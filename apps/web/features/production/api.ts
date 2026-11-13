import type { WorkspaceRole } from "../../lib/api";
import { withCsrf } from "../../lib/csrf";
import type { RenderInput } from "./composition";
import {
  canWrite,
  parseAssets,
  parseCapabilities,
  parseCost,
  parsePackage,
  parseRender,
  parseRenders,
  parseSceneJobs,
  parseScript,
  parseScriptRevision,
  record,
  type Asset,
  type CapabilityCatalog,
  type CostBreakdown,
  type OutputKind,
  type Page,
  type RenderJob,
  type RenderSummary,
  type SceneJobSummary,
  type SceneMediaPackage,
  type Script,
  type ScriptRevision,
} from "./model";

export class ProductionApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = "ProductionApiError";
  }
}

function message(status: number, payload: unknown): string {
  const detail = record(payload) && typeof payload.message === "string" ? payload.message : "";
  const summary =
    status === 401
      ? "Your session expired. Sign in again."
      : status === 403
        ? "You do not have access to this workspace action."
        : status === 404
          ? "This production record is no longer available."
          : status === 409
            ? "Production state changed. Refresh before another action."
            : status === 410
              ? "This render has expired."
              : "The production service could not complete the request.";
  return detail ? `${summary} ${detail}` : summary;
}

type RequestOptions = { method?: string; body?: Record<string, unknown> };

export class ProductionClient {
  public constructor(
    public readonly workspaceId: string,
    public readonly role: WorkspaceRole,
    private readonly signal: AbortSignal,
  ) {}

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    this.signal.throwIfAborted();
    const mutation = options.method !== undefined && options.method !== "GET";
    if (mutation && !canWrite(this.role))
      throw new ProductionApiError(403, "A verified owner or editor role is required.");
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/${path}`,
        withCsrf({
          method: options.method ?? "GET",
          credentials: "include",
          signal: this.signal,
          headers: { "Content-Type": "application/json" },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      );
    } catch (cause) {
      this.signal.throwIfAborted();
      throw new ProductionApiError(
        0,
        cause instanceof Error && cause.name === "AbortError"
          ? "Request cancelled."
          : mutation
            ? "The response was interrupted. Refresh production state before another action."
            : "The service is unavailable. Check your connection and try again.",
        mutation,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.ok && mutation)
        throw new ProductionApiError(
          502,
          "The server accepted the request but returned an unreadable response. Reconcile persisted production state before another action.",
          true,
        );
      payload = undefined;
    }
    this.signal.throwIfAborted();
    if (!response.ok)
      throw new ProductionApiError(
        response.status,
        message(response.status, payload),
        mutation && response.status >= 500,
      );
    return payload;
  }

  private async mutation<T>(
    path: string,
    body: Record<string, unknown> | undefined,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const value = await this.request(path, { method: "POST", ...(body ? { body } : {}) });
    try {
      return parse(value);
    } catch (cause) {
      if (cause instanceof ProductionApiError) throw cause;
      throw new ProductionApiError(
        502,
        "The server accepted the request but returned invalid production data. Reconcile persisted production state before another action.",
        true,
      );
    }
  }

  public async sceneJobs(page = 1, scriptId?: string): Promise<Page<SceneJobSummary>> {
    const query = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (scriptId) query.set("scriptId", scriptId);
    return parseSceneJobs(await this.request(`scene-media/jobs?${query}`), this.workspaceId);
  }

  public async package(jobId: string): Promise<SceneMediaPackage> {
    return parsePackage(
      await this.request(`scene-media/jobs/${encodeURIComponent(jobId)}`),
      this.workspaceId,
    );
  }

  public async capabilities(): Promise<CapabilityCatalog> {
    return parseCapabilities(await this.request("scene-media/capabilities"), this.workspaceId);
  }

  public async scripts(page = 1): Promise<{ items: Script[]; nextPage: number | null }> {
    const value = await this.request(`scripts?page=${page}`);
    if (
      !record(value) ||
      !Array.isArray(value.items) ||
      !(
        value.nextPage === null ||
        (Number.isSafeInteger(value.nextPage) && Number(value.nextPage) > page)
      )
    )
      throw new ProductionApiError(502, "The service returned an invalid scripts page.");
    return {
      items: value.items.map((item) => parseScript(item, this.workspaceId)),
      nextPage: value.nextPage as number | null,
    };
  }

  public async script(scriptId: string): Promise<Script> {
    return parseScript(
      await this.request(`scripts/${encodeURIComponent(scriptId)}`),
      this.workspaceId,
    );
  }

  public async scriptRevision(scriptId: string, expectedRevision: number): Promise<ScriptRevision> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new ProductionApiError(400, "The pinned script revision is invalid.");
    const seen = new Set<number>();
    let page = 1;
    for (let requestCount = 0; requestCount < 1000; requestCount += 1) {
      const value = await this.request(
        `scripts/${encodeURIComponent(scriptId)}/revisions?page=${page}`,
      );
      if (!record(value) || !Array.isArray(value.items))
        throw new ProductionApiError(502, "The service returned an invalid revision page.");
      const revisions = value.items.map(parseScriptRevision);
      for (const revision of revisions) {
        if (seen.has(revision.revision))
          throw new ProductionApiError(502, "The service returned duplicate script revisions.");
        seen.add(revision.revision);
      }
      const exact = revisions.find((revision) => revision.revision === expectedRevision);
      if (exact) return exact;
      if (value.nextPage === null) break;
      if (!Number.isSafeInteger(value.nextPage) || value.nextPage !== page + 1)
        throw new ProductionApiError(502, "The service returned invalid revision pagination.");
      page = value.nextPage;
    }
    throw new ProductionApiError(
      404,
      `Pinned script revision ${expectedRevision} is unavailable for this script.`,
    );
  }

  public async createJob(
    script: Script,
    outputs: { image: true; video: boolean; narration: boolean; dialogue: boolean },
    idempotencyKey: string,
  ): Promise<SceneMediaPackage> {
    return this.mutation(
      "scene-media/jobs",
      {
        scriptId: script.id,
        expectedScriptRevision: script.currentRevision,
        idempotencyKey,
        outputs,
      },
      (value) => parsePackage(value, this.workspaceId),
    );
  }

  public async mutate(
    job: SceneMediaPackage,
    operation: "retry" | "regenerate" | "replace",
    idempotencyKey: string,
    sceneId?: string,
    kind?: OutputKind,
  ): Promise<SceneMediaPackage> {
    const path =
      operation === "retry"
        ? `scene-media/jobs/${encodeURIComponent(job.jobId)}/retry`
        : `scene-media/jobs/${encodeURIComponent(job.jobId)}/scenes/${encodeURIComponent(sceneId ?? "")}/${operation}`;
    return this.mutation(
      path,
      {
        idempotencyKey,
        expectedJobVersion: job.version,
        ...(operation === "replace" ? { kind } : {}),
      },
      (value) => parsePackage(value, this.workspaceId),
    );
  }

  public async assignAsset(
    job: SceneMediaPackage,
    sceneId: string,
    kind: OutputKind,
    assetId: string,
    assetVersion: number,
    idempotencyKey: string,
  ): Promise<SceneMediaPackage> {
    return this.mutation(
      `scene-media/jobs/${encodeURIComponent(job.jobId)}/scenes/${encodeURIComponent(sceneId)}/assign-asset`,
      {
        idempotencyKey,
        expectedJobVersion: job.version,
        kind,
        assetId,
        assetVersion,
      },
      (value) => parsePackage(value, this.workspaceId),
    );
  }

  public async assets(): Promise<Asset[]> {
    return parseAssets(await this.request("assets"), this.workspaceId);
  }

  public async renders(page = 1, scriptId?: string): Promise<Page<RenderSummary>> {
    const query = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (scriptId) query.set("scriptId", scriptId);
    return parseRenders(await this.request(`composition/jobs?${query}`), this.workspaceId);
  }

  public async render(jobId: string): Promise<RenderJob> {
    return parseRender(
      await this.request(`composition/jobs/${encodeURIComponent(jobId)}`),
      this.workspaceId,
    );
  }

  public async startRender(input: RenderInput, idempotencyKey: string): Promise<RenderJob> {
    return this.mutation(
      "composition/jobs",
      { idempotencyKey, input, retentionDays: 90 },
      (value) => parseRender(value, this.workspaceId),
    );
  }

  public async cancelRender(jobId: string): Promise<RenderJob> {
    return this.mutation(
      `composition/jobs/${encodeURIComponent(jobId)}/cancel`,
      undefined,
      (value) => parseRender(value, this.workspaceId),
    );
  }

  public async retryRender(job: RenderJob, idempotencyKey: string): Promise<RenderJob> {
    return this.mutation(
      `composition/jobs/${encodeURIComponent(job.id)}/retry`,
      { idempotencyKey, input: job.input, retentionDays: job.retentionDays },
      (value) => parseRender(value, this.workspaceId),
    );
  }

  public async costs(scriptId: string): Promise<CostBreakdown> {
    return parseCost(
      await this.request(`usage/videos/${encodeURIComponent(scriptId)}`),
      this.workspaceId,
      scriptId,
    );
  }
}
