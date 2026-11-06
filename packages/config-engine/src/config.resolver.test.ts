import { describe, expect, it } from "vitest";
import {
  ConfigLockViolationError,
  ConfigValidationError,
  canonicalResolvedConfig,
  resolveConfig,
} from "./config.resolver.js";
import { platformDefaults, type ConfigLayer } from "./config.schema.js";

function layer(
  name: ConfigLayer["name"],
  values: ConfigLayer["values"],
  extra: Partial<Pick<ConfigLayer, "lockedFields" | "sourceId" | "sourceRefs" | "version">> = {},
): ConfigLayer {
  return {
    name,
    sourceId: extra.sourceId ?? `${name}-source`,
    ...(extra.version === undefined ? {} : { version: extra.version }),
    ...(extra.sourceRefs === undefined ? {} : { sourceRefs: extra.sourceRefs }),
    values,
    lockedFields: extra.lockedFields ?? [],
  };
}

describe("resolveConfig", () => {
  it("returns the platform defaults with a stable fingerprint", () => {
    const first = resolveConfig({ layers: [] });
    const second = resolveConfig({ layers: [] });
    expect(first.config).toEqual(platformDefaults);
    expect(first.layers).toEqual([]);
    expect(first.lockedFields).toEqual([
      "platformPolicy",
      "rightsPolicy",
      "safetyPolicy",
      "systemPolicy",
    ]);
    expect(first.configSha256).toBe(second.configSha256);
    expect(first.resolutionSha256).toBe(second.resolutionSha256);
    expect(first.configSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies every layer in precedence order regardless of input order", () => {
    const layers: ConfigLayer[] = [
      layer("video", { duration: { minSeconds: 25, maxSeconds: 55 } }),
      layer("workspace", { identity: { language: "es" } }),
      layer("series", { identity: { language: "it" } }),
      layer("channel", { identity: { language: "fr" } }),
      layer("genre", { identity: { language: "de" } }),
      layer("character", { identity: { language: "pt" } }),
    ];
    const resolved = resolveConfig({ layers });
    expect(resolved.config.identity.language).toBe("pt");
    expect(resolved.layers.map((item) => item.name)).toEqual([
      "workspace",
      "channel",
      "genre",
      "series",
      "character",
      "video",
    ]);
    expect(resolved.config.duration).toEqual({ minSeconds: 25, maxSeconds: 55 });
  });

  it("replaces arrays rather than concatenating them", () => {
    const resolved = resolveConfig({
      layers: [
        layer("workspace", { topics: { allowed: ["science"] } }),
        layer("channel", { topics: { allowed: ["history", "music"] } }),
      ],
    });
    expect(resolved.config.topics.allowed).toEqual(["history", "music"]);
    expect(resolved.config.topics.blocked).toEqual(platformDefaults.topics.blocked);
  });

  it("merges nested objects without dropping lower-layer siblings", () => {
    const resolved = resolveConfig({
      layers: [
        layer("workspace", { duration: { minSeconds: 20 } }),
        layer("channel", { duration: { maxSeconds: 45 } }),
      ],
    });
    expect(resolved.config.duration).toEqual({ minSeconds: 20, maxSeconds: 45 });
  });

  it("rejects a lower layer that writes a path locked by a higher layer", () => {
    const layers = [
      layer("workspace", { identity: { language: "es" } }, { lockedFields: ["identity.language"] }),
      layer("channel", { identity: { language: "fr" } }),
    ];
    expect(() => resolveConfig({ layers })).toThrowError(ConfigLockViolationError);
    try {
      resolveConfig({ layers });
    } catch (error) {
      expect(error).toMatchObject({
        code: "CONFIG_LOCK_VIOLATION",
        path: "identity.language",
        layer: "channel",
        sourceId: "channel-source",
        reason: "layer",
      });
    }
  });

  it("rejects a parent object when a nested path is locked", () => {
    const layers = [
      layer(
        "workspace",
        { topics: { allowed: ["science"] } },
        { lockedFields: ["topics.allowed"] },
      ),
      layer("channel", { topics: { allowed: ["history"] } }),
    ];
    expect(() => resolveConfig({ layers })).toThrowError(ConfigLockViolationError);
  });

  it("rejects a descendant when a parent path is locked", () => {
    const layers = [
      layer("workspace", { identity: { language: "es" } }, { lockedFields: ["identity"] }),
      layer("channel", { identity: { tone: "calm" } }),
    ];
    expect(() => resolveConfig({ layers })).toThrowError(ConfigLockViolationError);
  });

  it("rejects protected platform policy supplied by a layer", () => {
    const layers = [
      {
        name: "workspace",
        sourceId: "workspace-source",
        values: {
          safetyPolicy: {
            requiresHumanReview: false,
            minimumLevel: "standard",
            blockedTopics: [],
          },
        },
        lockedFields: [],
      } as unknown as ConfigLayer,
    ];
    expect(() => resolveConfig({ layers })).toThrowError(ConfigValidationError);
  });

  it("rejects duplicate layers", () => {
    expect(() =>
      resolveConfig({
        layers: [layer("channel", { identity: { tone: "a" } }), layer("channel", {})],
      }),
    ).toThrowError(ConfigValidationError);
  });

  it("rejects an invalid effective duration after merging", () => {
    expect(() =>
      resolveConfig({
        layers: [layer("workspace", { duration: { minSeconds: 90, maxSeconds: 30 } })],
      }),
    ).toThrowError(ConfigValidationError);
  });

  it("rejects lock paths outside the known configuration sections", () => {
    expect(() =>
      resolveConfig({
        layers: [layer("workspace", {}, { lockedFields: ["unknown.path"] })],
      }),
    ).toThrowError(ConfigValidationError);
  });

  it("includes layer provenance in the resolution fingerprint", () => {
    const values = { identity: { language: "es" as const } };
    const first = resolveConfig({
      layers: [layer("workspace", values, { sourceId: "snapshot-1", version: 1 })],
    });
    const second = resolveConfig({
      layers: [layer("workspace", values, { sourceId: "snapshot-1", version: 2 })],
    });
    expect(first.configSha256).toBe(second.configSha256);
    expect(first.resolutionSha256).not.toBe(second.resolutionSha256);
  });

  it("produces canonical output for diagnostics", () => {
    const resolved = resolveConfig({ layers: [] });
    expect(canonicalResolvedConfig(resolved)).toBe(canonicalResolvedConfig(resolved));
    expect(canonicalResolvedConfig(resolved)).toContain('"identity"');
  });
});
