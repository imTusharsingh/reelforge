import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of a JSON value with object keys sorted recursively. Array order is
 * significant and therefore preserved. This is the canonical form used for all
 * configuration and prompt fingerprints.
 */
export function canonicalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (isJsonObject(value)) {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) sorted[key] = canonicalizeJson(item);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalizeJson(value));
}

/** Stable JSON rendering used inside prompt bundles where readability matters. */
export function prettyCanonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalizeJson(value), null, 2);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function jsonFingerprint(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}

export function deepCloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function deepEqualJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
