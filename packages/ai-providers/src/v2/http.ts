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
  readonly code?: string;
}

const rejectionCodes = new Map<number, ReadonlySet<string>>([
  [400, new Set(["invalid_request", "INVALID_ARGUMENT"])],
  [401, new Set(["unauthenticated", "UNAUTHENTICATED"])],
  [403, new Set(["permission_denied", "PERMISSION_DENIED"])],
  [404, new Set(["not_found", "NOT_FOUND"])],
]);
const diagnosticCodes = new Set([
  ...Array.from(rejectionCodes.values()).flatMap((codes) => [...codes]),
  "resource_exhausted",
  "RESOURCE_EXHAUSTED",
]);
const failureLabels: Record<FailureKind, string> = {
  INVALID: "Provider invalid",
  REFUSAL: "Provider refusal",
  OUTAGE: "Provider outage",
  RATE_LIMIT: "Provider rate limit",
  NOT_CONFIGURED: "Provider not configured",
  INVALID_KEY: "Provider invalid key",
  NEEDS_HUMAN: "Provider needs human review",
};

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === "string" && diagnosticCodes.has(value) ? value : undefined;
}

export function providerFailureMessage(kind: FailureKind, http?: HttpFailureDetail): string {
  const label = Object.hasOwn(failureLabels, kind)
    ? failureLabels[kind]
    : "Provider dispatch failed";
  if (!http || !Number.isInteger(http.status) || http.status < 100 || http.status > 599)
    return label;
  const code = diagnosticCode(http.code);
  return `${label} (HTTP ${http.status}${code ? `, ${code}` : ""})`;
}

export class ProviderFailure extends Error {
  public readonly http?: HttpFailureDetail;
  public constructor(
    public readonly kind: FailureKind,
    public readonly dispatched: boolean,
    public readonly retryAfterMs = 0,
    http?: HttpFailureDetail,
  ) {
    super(providerFailureMessage(kind, http));
    if (http && Number.isInteger(http.status) && http.status >= 100 && http.status <= 599) {
      const code = diagnosticCode(http.code);
      this.http = { status: http.status, ...(code ? { code } : {}) };
    }
  }
}

export class EmptyMediaResponse extends ProviderFailure {
  public constructor() {
    super("INVALID", true);
    this.message = "Provider returned an empty media body";
  }
}

const errorBodyLimit = 4096;
const errorBodyDeadlineMs = 100;

async function readErrorPrefix(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const bytes = new Uint8Array(errorBodyLimit);
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<void> => {
    for (let reads = 0; reads < errorBodyLimit && length < bytes.length; reads++) {
      const { value, done } = await reader.read();
      if (done) return;
      const chunk = value.subarray(0, bytes.length - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
  };
  try {
    await Promise.race([
      read(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, errorBodyDeadlineMs);
      }),
    ]);
  } catch {
    // Preserve diagnostics already received when the stream fails.
  } finally {
    clearTimeout(timer);
    // Cancellation can wait on the underlying source. Do not wait for it to classify the status.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
}

function errorCodes(prefix: string): string[] {
  try {
    const error = record(record(JSON.parse(prefix)).error);
    return [diagnosticCode(error.code), diagnosticCode(error.status)].filter(
      (code): code is string => code !== undefined,
    );
  } catch {
    // A clipped JSON error can still contain complete leading scalar fields.
    const start = /^\s*\{\s*"error"\s*:\s*\{/.exec(prefix);
    if (!start) return [];
    const field =
      /\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+|true|false|null)\s*([,}])/y;
    field.lastIndex = start[0].length;
    const codes: string[] = [];
    for (let match = field.exec(prefix); match; match = field.exec(prefix)) {
      if (match[1] === '"code"' || match[1] === '"status"') {
        const code = diagnosticCode(match[2]?.slice(1, -1));
        if (code) codes.push(code);
      }
      if (match[3] === "}") break;
    }
    return codes;
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
      if (!bytes.length) throw new EmptyMediaResponse();
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
      if (!response.ok) return await this.reject(response, authenticated);
      return await consume(response);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure("OUTAGE", true);
    } finally {
      clearTimeout(timer);
    }
  }
  private async reject(response: Response, authenticated: boolean): Promise<never> {
    const codes = errorCodes(await readErrorPrefix(response.body));
    const status = response.status;
    const confirmed = codes.find((code) => rejectionCodes.get(status)?.has(code));
    const code = confirmed ?? codes[0];
    const detail = { status, ...(code ? { code } : {}) };
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
        : [401, 403].includes(response.status)
          ? "REFUSAL"
          : "INVALID",
      !authenticated || confirmed === undefined,
      0,
      detail,
    );
  }
}
