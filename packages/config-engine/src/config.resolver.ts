import { z } from "zod";
import {
  CONFIG_SCHEMA_VERSION,
  ConfigLayerNameSchema,
  ConfigLayerSchema,
  CreativeConfigSchema,
  PROTECTED_CONFIG_PATHS,
  platformDefaults,
  type ConfigLayer,
  type ConfigLayerName,
  type CreativeConfig,
} from "./config.schema.js";
import {
  canonicalJson,
  deepCloneJson,
  deepEqualJson,
  isJsonObject,
  jsonFingerprint,
  type JsonValue,
} from "./json.js";

/** Fixed precedence order. Callers never choose the order; the engine does. */
export const CONFIG_LAYER_ORDER = [
  "workspace",
  "channel",
  "genre",
  "series",
  "character",
  "video",
] as const satisfies readonly ConfigLayerName[];

const LAYER_RANK: Readonly<Record<ConfigLayerName, number>> = Object.freeze({
  workspace: 0,
  channel: 1,
  genre: 2,
  series: 3,
  character: 4,
  video: 5,
});

export type ConfigIssue = Readonly<{ path: string; message: string }>;

export class ConfigValidationError extends Error {
  public readonly code = "CONFIG_VALIDATION_ERROR";
  public readonly issues: readonly ConfigIssue[];

  public constructor(message: string, issues: readonly ConfigIssue[] = []) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export type ConfigLockReason = "protected" | "layer";
export type ConfigLockLayer = "platform" | ConfigLayerName;

export class ConfigLockViolationError extends Error {
  public readonly code = "CONFIG_LOCK_VIOLATION";
  public readonly path: string;
  public readonly layer: ConfigLockLayer;
  public readonly sourceId: string;
  public readonly lockedBy: string;
  public readonly reason: ConfigLockReason;

  public constructor(input: {
    path: string;
    layer: ConfigLockLayer;
    sourceId: string;
    lockedBy: string;
    reason: ConfigLockReason;
  }) {
    super(
      `Configuration path "${input.path}" is locked by ${input.lockedBy} and cannot be set by the ${input.layer} layer (${input.sourceId})`,
    );
    this.name = "ConfigLockViolationError";
    this.path = input.path;
    this.layer = input.layer;
    this.sourceId = input.sourceId;
    this.lockedBy = input.lockedBy;
    this.reason = input.reason;
  }
}

export type ResolvedLock = Readonly<{
  path: string;
  owner: "platform" | ConfigLayerName;
  sourceId: string;
  reason: ConfigLockReason;
}>;

export type ConfigLayerReference = Readonly<{
  name: ConfigLayerName;
  sourceId: string;
  version?: number;
  sourceRefs?: readonly string[];
}>;

export type ResolvedConfig = Readonly<{
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  config: CreativeConfig;
  layers: readonly ConfigLayerReference[];
  locks: readonly ResolvedLock[];
  lockedFields: readonly string[];
  configSha256: string;
  resolutionSha256: string;
}>;

export type ResolveConfigInput = Readonly<{
  platform?: CreativeConfig;
  layers: readonly ConfigLayer[];
}>;

const KNOWN_TOP_LEVEL_FIELDS = new Set<string>([
  "identity",
  "topics",
  "structure",
  "duration",
  "safetyProfile",
  "characters",
  "video",
  "policies",
  "prompt",
  ...PROTECTED_CONFIG_PATHS,
]);

function zodIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
  }));
}

function wrapZodError(message: string, error: z.ZodError): ConfigValidationError {
  return new ConfigValidationError(message, zodIssues(error));
}

function clonePlatform(platform: CreativeConfig): CreativeConfig {
  return CreativeConfigSchema.parse(deepCloneJson(platform as unknown as JsonValue));
}

function collectLeafPaths(value: JsonValue, prefix: string): string[] {
  if (Array.isArray(value)) return [prefix];
  if (!isJsonObject(value)) return [prefix];
  const keys = Object.keys(value);
  if (keys.length === 0) return [];
  const paths: string[] = [];
  for (const key of keys) {
    const child = value[key];
    if (child === undefined) continue;
    paths.push(...collectLeafPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`));
  }
  return paths;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function mergeValues(target: JsonValue, source: JsonValue): JsonValue {
  if (!isJsonObject(target) || !isJsonObject(source)) return deepCloneJson(source);
  const result: { [key: string]: JsonValue } = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    result[key] =
      existing !== undefined && isJsonObject(existing) && isJsonObject(value)
        ? mergeValues(existing, value)
        : deepCloneJson(value);
  }
  return result;
}

function layerReference(layer: ConfigLayer): ConfigLayerReference {
  return {
    name: layer.name,
    sourceId: layer.sourceId,
    ...(layer.version === undefined ? {} : { version: layer.version }),
    ...(layer.sourceRefs === undefined ? {} : { sourceRefs: [...layer.sourceRefs] }),
  };
}

function lockReference(lock: ResolvedLock): ResolvedLock {
  return lock;
}

/**
 * Validates that every declared lock targets a known top-level configuration section.
 * Nested paths are allowed because `structure` and `policies` carry arbitrary JSON.
 */
export function assertValidLockPaths(paths: readonly string[]): void {
  const issues: ConfigIssue[] = [];
  for (const [index, path] of paths.entries()) {
    const topLevel = path.split(".")[0] ?? "";
    if (!KNOWN_TOP_LEVEL_FIELDS.has(topLevel)) {
      issues.push({
        path: `lockedFields[${index}]`,
        message: `unknown configuration section "${topLevel}"`,
      });
    }
  }
  if (issues.length > 0)
    throw new ConfigValidationError("Configuration lock paths are invalid", issues);
}

/** Parses untrusted layer input and reports all Zod failures as typed issues. */
export function parseConfigLayers(input: unknown): ConfigLayer[] {
  const parsed = z.array(ConfigLayerSchema).safeParse(input);
  if (!parsed.success) throw wrapZodError("Configuration layers are invalid", parsed.error);
  return parsed.data;
}

/**
 * Resolves platform defaults and the supplied layers into one effective configuration.
 *
 * Rules:
 * - Layers are applied in `CONFIG_LAYER_ORDER`, regardless of input order.
 * - Objects merge recursively; arrays and scalar values replace the lower layer.
 * - A higher-precedence layer may lock a path with `lockedFields`; lower layers that
 *   supply that path, a descendant, or a parent object are rejected.
 * - Platform policy paths are always locked and are rejected if a layer attempts to
 *   supply them (the layer schema also omits them).
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const platform = clonePlatform(input.platform ?? platformDefaults);
  const layerResult = z.array(ConfigLayerSchema).safeParse(input.layers);
  if (!layerResult.success)
    throw wrapZodError("Configuration layers are invalid", layerResult.error);
  const layers = layerResult.data;

  const seen = new Set<ConfigLayerName>();
  for (const layer of layers) {
    if (seen.has(layer.name))
      throw new ConfigValidationError(`Configuration layer "${layer.name}" was supplied twice`);
    seen.add(layer.name);
  }

  for (const layer of layers) assertValidLockPaths(layer.lockedFields);

  const orderedLayers = [...layers].sort(
    (left, right) => LAYER_RANK[left.name] - LAYER_RANK[right.name],
  );

  const locks: ResolvedLock[] = PROTECTED_CONFIG_PATHS.map((path) => ({
    path,
    owner: "platform",
    sourceId: platform.platformPolicy.defaultsVersion,
    reason: "protected",
  }));
  const locksByPath = new Map<string, ResolvedLock>(locks.map((lock) => [lock.path, lock]));

  let effective: JsonValue = deepCloneJson(platform as unknown as JsonValue);

  for (const layer of orderedLayers) {
    const suppliedPaths = collectLeafPaths(layer.values as unknown as JsonValue, "");

    for (const path of suppliedPaths) {
      for (const lock of locks) {
        if (!pathsOverlap(path, lock.path)) continue;
        throw new ConfigLockViolationError({
          path,
          layer: layer.name,
          sourceId: layer.sourceId,
          lockedBy: lock.reason === "protected" ? "platform policy" : lock.sourceId,
          reason: lock.reason,
        });
      }
    }

    effective = mergeValues(effective, layer.values as unknown as JsonValue);

    for (const path of layer.lockedFields) {
      if (locksByPath.has(path)) continue;
      const lock: ResolvedLock = {
        path,
        owner: layer.name,
        sourceId: layer.sourceId,
        reason: "layer",
      };
      locks.push(lock);
      locksByPath.set(path, lock);
    }
  }

  const configResult = CreativeConfigSchema.safeParse(effective);
  if (!configResult.success)
    throw wrapZodError("Resolved configuration is invalid", configResult.error);

  const config = configResult.data;

  for (const path of PROTECTED_CONFIG_PATHS) {
    const expected = platform[path] as unknown as JsonValue;
    const actual = config[path] as unknown as JsonValue;
    if (!deepEqualJson(expected, actual))
      throw new ConfigLockViolationError({
        path,
        layer: "platform",
        sourceId: "resolver",
        lockedBy: "platform policy",
        reason: "protected",
      });
  }

  const sortedLocks = [...locks].sort((left, right) => left.path.localeCompare(right.path));
  const layerReferences = orderedLayers.map(layerReference);
  const configSha256 = jsonFingerprint(config as unknown as JsonValue);
  const resolutionSha256 = jsonFingerprint({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    platformDefaultsVersion: platform.platformPolicy.defaultsVersion,
    config: config as unknown as JsonValue,
    layers: layerReferences.map((reference) => ({
      name: reference.name,
      sourceId: reference.sourceId,
      ...(reference.version === undefined ? {} : { version: reference.version }),
      ...(reference.sourceRefs === undefined ? {} : { sourceRefs: [...reference.sourceRefs] }),
    })),
    locks: sortedLocks.map(lockReference),
  } as unknown as JsonValue);

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    config,
    layers: layerReferences,
    locks: sortedLocks,
    lockedFields: sortedLocks.map((lock) => lock.path),
    configSha256,
    resolutionSha256,
  };
}

/** Resolves untrusted JSON layer input. */
export function resolveConfigFromUnknown(input: unknown): ResolvedConfig {
  const parsed = z
    .object({ platform: CreativeConfigSchema.optional(), layers: z.array(ConfigLayerSchema) })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw wrapZodError("Configuration resolution input is invalid", parsed.error);
  return resolveConfig({
    ...(parsed.data.platform === undefined ? {} : { platform: parsed.data.platform }),
    layers: parsed.data.layers,
  });
}

/** True when a layer name is part of the fixed precedence chain. */
export function isConfigLayerName(value: unknown): value is ConfigLayerName {
  return ConfigLayerNameSchema.safeParse(value).success;
}

/** Deterministic canonical effective-configuration string for diagnostics. */
export function canonicalResolvedConfig(resolved: ResolvedConfig): string {
  return canonicalJson(resolved.config as unknown as JsonValue);
}
