import type { WorkspaceRole } from "../../lib/api";
import { withCsrf } from "../../lib/csrf";
import {
  isEditableRole,
  parseAccounts,
  parseAuthorizationUrl,
  parseChannels,
  parseCreatePostRequest,
  parseEligibleRenders,
  parseHistory,
  parsePlatforms,
  parsePost,
  parsePostPage,
  parsePosts,
  parsePreflight,
  type Channel,
  type CreatePostRequest,
  type EligibleRender,
  type PlatformAvailability,
  type Post,
  type Preflight,
  type PublishedRecord,
  type SocialAccount,
} from "./model";

export class PublishingApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = "PublishingApiError";
  }
}

function message(status: number, payload: unknown): string {
  const detail =
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
      ? payload.message
      : "";
  const summary =
    status === 400
      ? "The request was rejected. Check the composer fields."
      : status === 401
        ? "Your session expired. Sign in again."
        : status === 403
          ? "An owner or editor role is required for this publishing action."
          : status === 404
            ? "This publishing record is no longer available."
            : status === 409
              ? "Publishing state changed. Refresh the saved state before another action."
              : status === 422
                ? "The publishing service rejected this content."
                : "The publishing service could not complete the request.";
  return detail ? `${summary} ${detail}` : summary;
}

type Method = "GET" | "POST" | "PATCH";
type RequestOptions = { method?: Method; body?: unknown };

export class PublishingClient {
  private busy = false;
  private readonly confirmed = new Set<string>();
  private readonly local = new Set<string>();
  public suspended = false;

  public constructor(
    public readonly workspaceId: string,
    public readonly role: WorkspaceRole,
    private readonly signal: AbortSignal,
  ) {}

  private pendingKey(scope: string): string {
    return `reelforge:publishing:pending:${this.workspaceId}:${scope}`;
  }

  private createRequestKey(clientRequestId: string): string {
    return `reelforge:publishing:create:${this.workspaceId}:${clientRequestId}`;
  }

  private createLastKey(): string {
    return `reelforge:publishing:create:${this.workspaceId}:last`;
  }

  private rememberCreateRequest(request: CreatePostRequest): void {
    try {
      sessionStorage.setItem(
        this.createRequestKey(request.clientRequestId),
        JSON.stringify(request),
      );
      sessionStorage.setItem(this.createLastKey(), request.clientRequestId);
    } catch {
      // The pending marker still fails closed; recovery may be unavailable.
    }
  }

  public pendingCreate(): CreatePostRequest | null {
    try {
      const clientRequestId = sessionStorage.getItem(this.createLastKey());
      if (clientRequestId === null || !this.pending(`create:${clientRequestId}`)) return null;
      const raw = sessionStorage.getItem(this.createRequestKey(clientRequestId));
      if (raw === null) return null;
      return parseCreatePostRequest(JSON.parse(raw) as unknown, clientRequestId);
    } catch {
      return null;
    }
  }

  public hasPendingCreate(): boolean {
    try {
      const clientRequestId = sessionStorage.getItem(this.createLastKey());
      return clientRequestId !== null && this.pending(`create:${clientRequestId}`);
    } catch {
      return true;
    }
  }

  public discardCreate(clientRequestId: string): void {
    this.confirmed.delete(`create:${clientRequestId}`);
    this.clear(`create:${clientRequestId}`);
  }

  public pending(scope: string): boolean {
    try {
      return this.local.has(scope) || sessionStorage.getItem(this.pendingKey(scope)) !== null;
    } catch {
      // If browser recovery storage is unavailable, fail closed before dispatch.
      return true;
    }
  }

  private mark(scope: string): void {
    if (this.pending(scope))
      throw new PublishingApiError(
        409,
        "A previous action may still be pending. Reconcile the saved state before another action.",
      );
    try {
      sessionStorage.setItem(this.pendingKey(scope), "pending");
    } catch {
      throw new PublishingApiError(
        0,
        "Browser recovery storage is unavailable; the action was not sent.",
      );
    }
    this.local.add(scope);
  }

  private clear(scope: string): void {
    this.local.delete(scope);
    try {
      sessionStorage.removeItem(this.pendingKey(scope));
      if (scope.startsWith("create:")) {
        const clientRequestId = scope.slice("create:".length);
        sessionStorage.removeItem(this.createRequestKey(clientRequestId));
        if (sessionStorage.getItem(this.createLastKey()) === clientRequestId)
          sessionStorage.removeItem(this.createLastKey());
      }
    } catch {
      // The local set still prevents a repeat within this page session.
    }
  }

  public acknowledge(scope: string): void {
    if (!this.confirmed.delete(scope))
      throw new Error("Fetch the persisted publishing state before acknowledging it.");
    this.clear(scope);
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    this.signal.throwIfAborted();
    const method = options.method ?? "GET";
    const mutation = method !== "GET";
    if (mutation && !isEditableRole(this.role))
      throw new PublishingApiError(403, "A verified owner or editor role is required.");
    if (mutation && this.suspended)
      throw new PublishingApiError(403, "Access changed. Refresh your verified session.");
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/${path}`,
        withCsrf({
          method,
          credentials: "include",
          signal: this.signal,
          headers: { "Content-Type": "application/json" },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      );
    } catch (cause) {
      this.signal.throwIfAborted();
      throw new PublishingApiError(
        0,
        cause instanceof Error && cause.name === "AbortError"
          ? "Request cancelled."
          : mutation
            ? "The response was interrupted. Refresh the saved publishing state before another action."
            : "The publishing service is unavailable. Retry when connected.",
        mutation,
      );
    }
    if (response.status === 401 || response.status === 403) this.suspended = true;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.ok)
        throw new PublishingApiError(
          502,
          "The server accepted the request but returned an unreadable response. Reconcile persisted state before another action.",
          mutation,
        );
      payload = undefined;
    }
    this.signal.throwIfAborted();
    if (!response.ok)
      throw new PublishingApiError(response.status, message(response.status, payload));
    return payload;
  }

  private async read<T>(path: string, parse: (value: unknown) => T): Promise<T> {
    const value = await this.request(path);
    try {
      return parse(value);
    } catch (cause) {
      if (cause instanceof PublishingApiError) throw cause;
      throw new PublishingApiError(
        502,
        cause instanceof Error
          ? cause.message
          : "The publishing service returned invalid or mismatched data.",
      );
    }
  }

  private async mutate<T>(
    scope: string,
    method: Method,
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    if (this.busy)
      throw new PublishingApiError(
        409,
        "Another publishing action is already in progress. Wait for it to finish.",
      );
    this.busy = true;
    try {
      this.mark(scope);
      let value: unknown;
      try {
        value = await this.request(path, { method, ...(body === undefined ? {} : { body }) });
      } catch (cause) {
        if (cause instanceof PublishingApiError) {
          if (cause.status === 0 || cause.status >= 500)
            throw new PublishingApiError(cause.status, cause.message, true);
          // A definitive rejection means the write did not commit, so the
          // pending marker must not block a corrected request.
          this.clear(scope);
        }
        throw cause;
      }
      let next: T;
      try {
        next = parse(value);
      } catch {
        throw new PublishingApiError(
          502,
          "The server accepted the request but returned invalid publishing data. Reconcile the saved state before another action.",
          true,
        );
      }
      this.clear(scope);
      return next;
    } finally {
      this.busy = false;
    }
  }

  public async platforms(): Promise<PlatformAvailability[]> {
    return this.read("publishing/platforms", parsePlatforms);
  }

  public async accounts(): Promise<SocialAccount[]> {
    return this.read("social-accounts", (value) => parseAccounts(value, this.workspaceId));
  }

  public pendingAccountScopes(): string[] {
    const prefix = this.pendingKey("");
    const scopes = new Set(
      [...this.local].filter(
        (scope) => scope.startsWith("account:") || scope.startsWith("connect:"),
      ),
    );
    try {
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const scope = key.slice(prefix.length);
        if (scope.startsWith("account:") || scope.startsWith("connect:")) scopes.add(scope);
      }
    } catch {
      /* mark() still refuses to dispatch when recovery storage is unavailable. */
    }
    return [...scopes];
  }

  public async reconcileAccounts(): Promise<SocialAccount[]> {
    const items = await this.accounts();
    for (const scope of this.pendingAccountScopes()) this.confirmed.add(scope);
    return items;
  }

  public async channels(): Promise<Channel[]> {
    return this.read("channels", (value) => parseChannels(value, this.workspaceId));
  }

  public async eligibleRenders(
    channelId?: string,
    cursor?: string,
  ): Promise<{ items: EligibleRender[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (channelId) query.set("channelId", channelId);
    if (cursor) query.set("cursor", cursor);
    const text = query.toString();
    const suffix = text.length === 0 ? "" : `?${text}`;
    return this.read(`publishing/eligible-renders${suffix}`, parseEligibleRenders);
  }

  public async drafts(cursor?: string): Promise<{ items: Post[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ status: "DRAFT" });
    if (cursor) query.set("cursor", cursor);
    return this.read(`publishing/posts?${query.toString()}`, parsePostPage);
  }

  public async calendar(from: string, to: string): Promise<Post[]> {
    const query = new URLSearchParams({ from, to });
    return this.read(`publishing/calendar?${query.toString()}`, parsePosts);
  }

  public async post(postId: string): Promise<Post> {
    return this.read(`publishing/posts/${encodeURIComponent(postId)}`, (value) =>
      parsePost(value, postId),
    );
  }

  public async history(): Promise<PublishedRecord[]> {
    return this.read("publishing/published-records", (value) =>
      parseHistory(value, this.workspaceId),
    );
  }

  public async preflight(destinationId: string): Promise<Preflight> {
    return this.read(
      `publishing/destinations/${encodeURIComponent(destinationId)}/preflight`,
      (value) => parsePreflight(value, destinationId),
    );
  }

  public async reconcilePost(postId: string): Promise<Post> {
    const post = await this.post(postId);
    this.confirmed.add(`post:${postId}`);
    return post;
  }

  public async createPost(request: CreatePostRequest): Promise<Post> {
    this.rememberCreateRequest(request);
    const scope = `create:${request.clientRequestId}`;
    const post = await this.mutate(scope, "POST", "publishing/posts", request, (value) =>
      parsePost(value),
    );
    this.confirmed.add(`post:${post.id}`);
    return post;
  }

  public async recoverCreate(request: CreatePostRequest): Promise<Post> {
    const scope = `create:${request.clientRequestId}`;
    if (!this.pending(scope))
      throw new PublishingApiError(409, "No interrupted creation is recorded for this request.");
    if (this.busy)
      throw new PublishingApiError(
        409,
        "Another publishing action is already in progress. Wait for it to finish.",
      );
    this.busy = true;
    try {
      let value: unknown;
      try {
        value = await this.request("publishing/posts", { method: "POST", body: request });
      } catch (cause) {
        if (cause instanceof PublishingApiError) {
          if (cause.status === 0 || cause.status >= 500)
            throw new PublishingApiError(cause.status, cause.message, true);
          this.clear(scope);
        }
        throw cause;
      }
      let post: Post;
      try {
        post = parsePost(value);
      } catch {
        throw new PublishingApiError(
          502,
          "The server accepted the request but returned invalid publishing data. Reconcile the saved state before another action.",
          true,
        );
      }
      this.clear(scope);
      this.confirmed.add(`post:${post.id}`);
      return post;
    } finally {
      this.busy = false;
    }
  }

  public async reschedule(postId: string, scheduledAt: string | null): Promise<Post> {
    return this.mutate(
      `post:${postId}`,
      "PATCH",
      `publishing/posts/${encodeURIComponent(postId)}`,
      { scheduledAt },
      (value) => parsePost(value, postId),
    );
  }

  public async cancel(postId: string): Promise<Post> {
    return this.mutate(
      `post:${postId}`,
      "POST",
      `publishing/posts/${encodeURIComponent(postId)}/cancel`,
      undefined,
      (value) => parsePost(value, postId),
    );
  }

  public async publishNow(postId: string, destinationId: string): Promise<Post> {
    return this.destinationMutation(postId, destinationId, "publish");
  }

  public async retry(postId: string, destinationId: string): Promise<Post> {
    return this.destinationMutation(postId, destinationId, "retry");
  }

  public async reconcileDestination(postId: string, destinationId: string): Promise<Post> {
    const post = await this.destinationMutation(postId, destinationId, "reconcile");
    this.confirmed.add(`post:${postId}`);
    return post;
  }

  private destinationMutation(
    postId: string,
    destinationId: string,
    action: "publish" | "retry" | "reconcile",
  ): Promise<Post> {
    return this.mutate(
      `post:${postId}`,
      "POST",
      `publishing/destinations/${encodeURIComponent(destinationId)}/${action}`,
      undefined,
      (value) => {
        const post = parsePost(value, postId);
        if (!post.destinations.some((destination) => destination.id === destinationId))
          throw new Error("The publishing service returned a different destination.");
        return post;
      },
    );
  }

  public async connect(
    channelId: string,
    platform: string,
    remoteAccountId: string,
  ): Promise<string> {
    const scope = `connect:${channelId}:${platform}`;
    return this.mutate(
      scope,
      "POST",
      `channels/${encodeURIComponent(channelId)}/social-accounts/${encodeURIComponent(platform)}/connect`,
      { remoteAccountId },
      parseAuthorizationUrl,
    );
  }

  public async refreshAccount(accountId: string): Promise<void> {
    await this.accountAction(accountId, "refresh");
  }

  public async checkAccountHealth(accountId: string): Promise<void> {
    await this.accountAction(accountId, "health");
  }

  public async revokeAccount(accountId: string): Promise<void> {
    await this.accountAction(accountId, "revoke");
  }

  private async accountAction(
    accountId: string,
    action: "refresh" | "health" | "revoke",
  ): Promise<void> {
    await this.mutate(
      `account:${accountId}`,
      "POST",
      `social-accounts/${encodeURIComponent(accountId)}/${action}`,
      undefined,
      () => undefined,
    );
  }
}
