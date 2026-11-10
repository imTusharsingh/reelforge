/**
 * Log redaction (M19-T03). Every value that reaches a log line, a span attribute, a metric label,
 * or an audit metadata field passes through `redact`. It removes secrets (passwords, tokens,
 * cookies, API keys, encryption keys, connection-string credentials) and private media URLs
 * (signed object URLs, resumable upload session URIs, local storage paths in URLs).
 *
 * Rules (architecture baseline §9):
 * - A field whose name looks secret is replaced entirely with `[REDACTED]`.
 * - Every URL inside any string keeps only its scheme and host: `https://host/[REDACTED]`. Path,
 *   query, fragment, and user-info are dropped, so signed URLs and upload session URIs never leak.
 * - Bearer tokens, JWTs, Google OAuth access/refresh tokens, `key=value` secrets, and JSON/YAML
 *   style `"key": "value"` / `key: value` secrets embedded in free text are masked.
 * - Values of secret-looking environment variables registered at startup are masked wherever
 *   they appear verbatim.
 */

export const REDACTED = "[REDACTED]";

const SECRET_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
  "ciphertext",
  "encryptionkey",
  "signature",
] as const;

const SECRET_KEYS_EXACT = new Set([
  "sessionuri",
  "uploadurl",
  "uploaduri",
  "signedurl",
  "presignedurl",
  "sessionurl",
  "otp",
  "code_verifier",
  "codeverifier",
  "dsn",
  "databaseurl",
  "redisurl",
  "storagekey",
  "objectkey",
  "storagepath",
  "filepath",
  "localpath",
]);

/** Field names that look secret are dropped whole. */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_KEYS_EXACT.has(normalized)) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

const URL_PATTERN = /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s"'<>`]+)/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const GOOGLE_TOKEN_PATTERN = /\b(ya29\.[0-9A-Za-z_-]{10,}|1\/\/[0-9A-Za-z_-]{10,})/g;
const KEY_VALUE_PATTERN =
  /\b(password|passwd|secret|token|access_token|refresh_token|id_token|client_secret|api[_-]?key|apikey|sig|signature|x-amz-signature|x-amz-credential|upload_id)=([^&\s"',;]+)/gi;
/**
 * JSON / YAML / JS-object style secrets in free text, for example a provider error body
 * `{"access_token":"ya29…","client_secret":"…"}` or a YAML line `client_secret: abc`. The key may be
 * quoted with `"` or `'` (or bare, or `\"` inside an already-encoded JSON string); the value is a
 * quoted string (escapes honoured) or a bare token. Key-name runs are length-bounded so the
 * pattern stays linear. The key's quoting and the value's quote style are kept so JSON stays
 * readable.
 */
const STRUCTURED_SECRET_PATTERN =
  /(\\?["']?)\b([A-Za-z0-9_-]{0,40}(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|cookie|private[_-]?key|credentials?|signature)[A-Za-z0-9_-]{0,40})\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/gi;
const SESSION_COOKIE_PATTERN = /\b(reelforge_session)=([^;\s"']+)/gi;

const registeredSecrets = new Set<string>();

/** Registers literal secret values (for example from env) to mask wherever they appear. */
export function registerSecretValues(values: Iterable<string | undefined | null>): void {
  for (const value of values) {
    if (typeof value === "string" && value.length >= 8) registeredSecrets.add(value);
  }
}

/** Env var names whose values are secrets (or contain credentials, like connection strings). */
export function isSecretEnvName(name: string): boolean {
  return /(SECRET|TOKEN|PASSWORD|PASSWD|_KEY$|KEY_|PRIVATE|CREDENTIAL|DATABASE_URL|REDIS_URL|_DSN$)/i.test(
    name,
  );
}

/** Registers every secret-looking env value; call once at process start. */
export function registerSecretEnv(env: Readonly<Record<string, string | undefined>>): void {
  registerSecretValues(
    Object.entries(env)
      .filter(([name]) => isSecretEnvName(name))
      .map(([, value]) => value),
  );
}

/** Test helper: forget registered secret values. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

function redactUrl(scheme: string, rest: string): string {
  // Authority ends at the first "/", "?" or "#". Drop user-info (credentials) before "@".
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : authority.slice(at + 1);
  const hadMore = end !== -1 || at !== -1;
  return `${scheme}://${host}${hadMore ? `/${REDACTED}` : ""}`;
}

/** Masks secrets and private URLs inside free text. */
export function redactString(input: string): string {
  let output = input;
  for (const secret of registeredSecrets) {
    if (output.includes(secret)) output = output.split(secret).join(REDACTED);
  }
  output = output
    .replace(BEARER_PATTERN, (_match, kind: string) => `${kind} ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(GOOGLE_TOKEN_PATTERN, REDACTED)
    .replace(SESSION_COOKIE_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(KEY_VALUE_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(
      STRUCTURED_SECRET_PATTERN,
      (_match, quote: string, key: string, separator: string, value: string) => {
        const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
        return `${quote}${key}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
      },
    )
    .replace(URL_PATTERN, (_match, scheme: string, rest: string) => redactUrl(scheme, rest));
  return output;
}

export type RedactOptions = Readonly<{ maxDepth?: number; maxStringLength?: number }>;

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING = 4_000;

/** Serializes an Error into a plain, redacted object. */
export function serializeError(error: Error, options: RedactOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: truncate(redactString(error.message), options),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out["code"] = code;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") out["status"] = status;
  if (typeof error.stack === "string") out["stack"] = truncate(redactString(error.stack), options);
  if (error.cause !== undefined) out["cause"] = redact(error.cause, options);
  return out;
}

function truncate(value: string, options: RedactOptions): string {
  const max = options.maxStringLength ?? DEFAULT_MAX_STRING;
  return value.length > max ? `${value.slice(0, max)}…[truncated ${value.length - max}]` : value;
}

/**
 * Returns a redacted, JSON-safe copy of any value. Never throws; cycles become `[Circular]`,
 * buffers become their length, functions and symbols are dropped.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const seen = new WeakSet<object>();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const walk = (current: unknown, depth: number): unknown => {
    if (current === null || current === undefined) return current;
    switch (typeof current) {
      case "string":
        return truncate(redactString(current), options);
      case "number":
      case "boolean":
        return current;
      case "bigint":
        return current.toString();
      case "function":
      case "symbol":
        return undefined;
      default:
        break;
    }
    const object = current as object;
    if (current instanceof Date)
      return Number.isNaN(current.getTime()) ? null : current.toISOString();
    if (current instanceof Error) return serializeError(current, options);
    if (current instanceof Uint8Array) return `[Buffer length=${current.byteLength}]`;
    if (current instanceof URL)
      return redactUrl(current.protocol.replace(/:$/, ""), current.host + "/");
    if (seen.has(object)) return "[Circular]";
    if (depth >= maxDepth) return "[MaxDepth]";
    seen.add(object);
    if (Array.isArray(current)) {
      const limited = current.slice(0, 100).map((item) => walk(item, depth + 1));
      if (current.length > 100) limited.push(`[+${current.length - 100} more]`);
      return limited;
    }
    if (current instanceof Map) return walk(Object.fromEntries(current), depth);
    if (current instanceof Set) return walk([...current], depth);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      const next = walk(item, depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  };
  try {
    return walk(value, 0);
  } catch {
    return "[Unserializable]";
  }
}
