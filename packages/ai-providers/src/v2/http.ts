import { providerKeyIssue } from "./config.js";

export type Json = Record<string, unknown>;
export type FailureKind =
  | "OUTAGE"
  | "REFUSAL"
  | "RATE_LIMIT"
  | "INVALID"
  | "NOT_CONFIGURED"
  | "INVALID_KEY"
  | "NEEDS_HUMAN";
export class ProviderFailure extends Error {
  public constructor(
    public readonly kind: FailureKind,
    public readonly dispatched: boolean,
    public readonly retryAfterMs = 0,
  ) {
    super(`Provider ${kind.toLowerCase()}`);
  }
}
export function record(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProviderFailure("INVALID", true);
  return value as Json;
}
export function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ProviderFailure("INVALID", true);
  return value;
}
export class ProviderHttp {
  public constructor(
    private readonly key: string,
    private readonly vendor: "gemini" | "xai",
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
  ) {}
  public assertKey(): void {
    const issue = providerKeyIssue(this.vendor, this.key);
    if (issue) throw new ProviderFailure(issue, false);
  }
  public json(path: string, body?: Json, idemKey?: string): Promise<Json> {
    return this.request(
      path,
      async (response) => {
        try {
          return record(await response.json());
        } catch {
          throw new ProviderFailure("INVALID", true);
        }
      },
      body,
      idemKey,
    );
  }
  public bytes(uri: string): Promise<Uint8Array> {
    return this.request(uri, async (response) => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new ProviderFailure("INVALID", true);
      return bytes;
    });
  }
  private async request<T>(
    path: string,
    consume: (response: Response) => Promise<T>,
    body?: Json,
    idemKey?: string,
  ): Promise<T> {
    this.assertKey();
    const base =
      this.vendor === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta/"
        : "https://api.x.ai/v1/";
    const url = new URL(path, base);
    const authenticated = url.origin === new URL(base).origin;
    if (
      url.protocol !== "https:" ||
      (!authenticated &&
        !["vidgen.x.ai", "media.x.ai", "storage.googleapis.com"].includes(url.hostname))
    )
      throw new ProviderFailure("INVALID", false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (authenticated)
        headers[this.vendor === "gemini" ? "x-goog-api-key" : "Authorization"] =
          this.vendor === "gemini" ? this.key : `Bearer ${this.key}`;
      if (this.vendor === "gemini") headers["Api-Revision"] = "2026-05-20";
      if (body) headers["Content-Type"] = "application/json";
      if (idemKey) headers["Idempotency-Key"] = idemKey;
      const response = await this.fetcher(url.toString(), {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) this.reject(response);
      return await consume(response);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure("OUTAGE", true);
    } finally {
      clearTimeout(timer);
    }
  }
  private reject(response: Response): never {
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds = Number(retry);
      const delay =
        retry === null
          ? 1000
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retry) - Date.now();
      throw new ProviderFailure("RATE_LIMIT", true, Math.max(1000, delay || 1000));
    }
    throw new ProviderFailure(
      response.status >= 500 || response.status === 408
        ? "OUTAGE"
        : response.status === 403
          ? "REFUSAL"
          : "INVALID",
      true,
    );
  }
}
