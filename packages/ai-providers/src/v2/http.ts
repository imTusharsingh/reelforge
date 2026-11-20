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
interface HttpFailureDetail {
  readonly status: number;
  readonly message?: string;
  readonly providerStatus?: string;
  readonly code?: string;
}

export class ProviderFailure extends Error {
  public constructor(
    public readonly kind: FailureKind,
    public readonly dispatched: boolean,
    public readonly retryAfterMs = 0,
    public readonly http?: HttpFailureDetail,
  ) {
    const detail =
      http && [http.providerStatus, http.code, http.message].filter(Boolean).join("; ");
    super(
      `Provider ${kind.toLowerCase()}${http ? ` (HTTP ${http.status})` : ""}${detail ? `: ${detail}` : ""}`,
    );
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
      if (!response.ok) return await this.reject(response, idemKey);
      return await consume(response);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure("OUTAGE", true);
    } finally {
      clearTimeout(timer);
    }
  }
  private async errorDetail(response: Response, idemKey?: string): Promise<HttpFailureDetail> {
    const status = response.status;
    try {
      const error = record(record(await response.json()).error);
      const sanitize = (value: unknown): string | undefined => {
        if (typeof value !== "string") return undefined;
        let safe = value;
        for (const secret of [this.key, idemKey]) {
          if (secret) safe = safe.replaceAll(secret, "<redacted>");
        }
        // Discard appended headers, URLs and structured payloads that may echo request data.
        return (
          safe
            .split(
              /\r|\n|\{|\[|https?:\/\/|\b(?:authorization|bearer|(?:x[-_]?goog[-_]?)?api[-_ ]?key|idempotency[-_ ]?key)\b/i,
              1,
            )[0]
            ?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
            .trim()
            .slice(0, 240) || undefined
        );
      };
      const label = (value: unknown): string | undefined => {
        const safe = sanitize(typeof value === "number" ? String(value) : value);
        return safe && /^[a-z0-9_-]{1,64}$/i.test(safe) ? safe : undefined;
      };
      const message = sanitize(error.message);
      const providerStatus = label(error.status);
      const code = label(error.code);
      return {
        status,
        ...(message ? { message } : {}),
        ...(providerStatus ? { providerStatus } : {}),
        ...(code ? { code } : {}),
      };
    } catch {
      return { status };
    }
  }
  private async reject(response: Response, idemKey?: string): Promise<never> {
    const detail = await this.errorDetail(response, idemKey);
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds = Number(retry);
      const delay =
        retry === null
          ? 1000
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retry) - Date.now();
      throw new ProviderFailure("RATE_LIMIT", true, Math.max(1000, delay || 1000), detail);
    }
    throw new ProviderFailure(
      response.status >= 500 || response.status === 408
        ? "OUTAGE"
        : response.status === 403
          ? "REFUSAL"
          : "INVALID",
      true,
      0,
      detail,
    );
  }
}
