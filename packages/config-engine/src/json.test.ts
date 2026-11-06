import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  deepEqualJson,
  jsonFingerprint,
  prettyCanonicalJson,
  type JsonValue,
} from "./json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const value: JsonValue = { b: 1, a: { d: [3, 2], c: true } };
    expect(canonicalJson(value)).toBe('{"a":{"c":true,"d":[3,2]},"b":1}');
    expect(prettyCanonicalJson(value)).toContain('\n  "a": {');
  });

  it("produces stable fingerprints independent of key insertion order", () => {
    expect(jsonFingerprint({ a: 1, b: 2 })).toBe(jsonFingerprint({ b: 2, a: 1 }));
    expect(jsonFingerprint({ a: 1, b: 2 })).not.toBe(jsonFingerprint({ a: 1, b: 3 }));
  });

  it("compares JSON values structurally", () => {
    expect(deepEqualJson({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepEqualJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});
