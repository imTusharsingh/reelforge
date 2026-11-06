import { z } from "zod";
import {
  CharacterRuleSchema,
  ConfigValidationError,
  DurationConfigSchema,
  JsonValueSchema,
  LayerValuesSchema,
  LockPathSchema,
  SafetyProfileSchema,
  StructureSchema,
  parsePromptTemplateRefs,
  type ConfigIssue,
  type ConfigLayer,
  type JsonValue,
  type LayerValues,
  type PromptTemplateReference,
} from "@reelforge/config-engine";
import { profileFromJson } from "../character/character.validation.js";
import type { WorkspaceSnapshotRow } from "./config.types.js";

const TopicArraySchema = z.array(z.string().trim().min(1).max(120)).max(200);
const LockArraySchema = z.array(LockPathSchema).max(200);

function zodIssues(error: z.ZodError, prefix = ""): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join(".");
    return {
      path: prefix.length === 0 ? path : `${prefix}.${path}`,
      message: issue.message,
    };
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ConfigValidationError(`${label} is invalid`, zodIssues(parsed.error));
  return parsed.data;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ConfigValidationError(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function layer(
  name: ConfigLayer["name"],
  sourceId: string,
  values: unknown,
  options: Readonly<{
    version?: number;
    sourceRefs?: readonly string[];
    lockedFields?: readonly string[];
  }> = {},
): ConfigLayer {
  return {
    name,
    sourceId,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.sourceRefs === undefined ? {} : { sourceRefs: [...options.sourceRefs] }),
    values: parse(LayerValuesSchema, values, `${name} layer values`),
    lockedFields: [...(options.lockedFields ?? [])],
  };
}

export type ChannelSnapshotRow = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string;
  version: number;
  config: unknown;
}>;

/**
 * M02 channel snapshots carry branding and channel-level policy intents. Only
 * fields that map to the M05 configuration schema are projected; unknown channel
 * metadata is deliberately not reinterpreted.
 */
export function channelLayerFromSnapshot(row: ChannelSnapshotRow): ConfigLayer {
  const config = objectValue(row.config, "channel snapshot config");
  const identity: Record<string, string> = {};
  for (const field of ["language", "audience", "niche"] as const) {
    const value = optionalText(config[field]);
    if (value !== undefined) identity[field] = value;
  }

  const policies: Record<string, JsonValue> = {};
  for (const field of [
    "goals",
    "schedule",
    "automationDefaults",
    "approvalPolicy",
    "publishingDestinations",
  ] as const) {
    const value = config[field];
    if (value === undefined || value === null) continue;
    policies[field] = parse(JsonValueSchema, value, `channel ${field}`);
  }

  const values: Record<string, unknown> = {};
  if (Object.keys(identity).length > 0) values.identity = identity;
  if (Object.keys(policies).length > 0) values.policies = policies;

  return layer("channel", row.channelId, values, {
    version: row.version,
    sourceRefs: [row.channelId, row.id],
  });
}

export type GenreRow = Readonly<{
  id: string;
  workspaceId: string;
  audience: string;
  tone: string;
  language: string;
  topicsAllowed: unknown;
  topicsBlocked: unknown;
  structure: unknown;
  durationPreference: unknown;
  safetyProfile: unknown;
}>;

export function genreLayerFromRow(row: GenreRow): ConfigLayer {
  return layer(
    "genre",
    row.id,
    {
      identity: {
        audience: row.audience,
        tone: row.tone,
        language: row.language,
      },
      topics: {
        allowed: parse(TopicArraySchema, row.topicsAllowed, "genre topicsAllowed"),
        blocked: parse(TopicArraySchema, row.topicsBlocked, "genre topicsBlocked"),
      },
      structure: parse(StructureSchema, row.structure, "genre structure"),
      duration: parse(DurationConfigSchema, row.durationPreference, "genre durationPreference"),
      safetyProfile: parse(SafetyProfileSchema, row.safetyProfile, "genre safetyProfile"),
    },
    { sourceRefs: [row.id] },
  );
}

export type SeriesRow = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string;
  genreId: string;
  format: string;
  frequency: string;
  promptRefs: unknown;
}>;

export function seriesLayerFromRow(row: SeriesRow): ConfigLayer {
  let refs: PromptTemplateReference[];
  try {
    refs = parsePromptTemplateRefs(row.promptRefs);
  } catch (error) {
    throw new ConfigValidationError("Series promptRefs are invalid", [
      {
        path: "promptRefs",
        message: error instanceof Error ? error.message : "invalid prompt references",
      },
    ]);
  }
  return layer(
    "series",
    row.id,
    {
      identity: { format: row.format, frequency: row.frequency },
      ...(refs.length === 0 ? {} : { prompt: { templateRefs: refs } }),
    },
    { sourceRefs: [row.id, row.genreId] },
  );
}

export type CharacterVersionRow = Readonly<{
  id: string;
  workspaceId: string;
  characterId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  profile: unknown;
  checksumSha256: string;
}>;

export function characterLayerFromVersions(
  rows: readonly CharacterVersionRow[],
): ConfigLayer | null {
  if (rows.length === 0) return null;
  const characters = rows.map((row) => {
    let profile: ReturnType<typeof profileFromJson>;
    try {
      profile = profileFromJson(row.profile);
    } catch (error) {
      throw new ConfigValidationError(`Published character version ${row.id} is invalid`, [
        {
          path: "profile",
          message: error instanceof Error ? error.message : "invalid character profile",
        },
      ]);
    }
    return parse(
      CharacterRuleSchema,
      {
        characterId: row.characterId,
        characterVersionId: row.id,
        version: row.version,
        checksumSha256: row.checksumSha256,
        name: profile.name,
        description: profile.description,
        personality: profile.personality,
        voicePreference: profile.voicePreference,
        visualInvariants: profile.visualInvariants,
        variationRules: profile.variationRules,
      },
      `character version ${row.id}`,
    );
  });

  return layer(
    "character",
    "character-version-set",
    { characters },
    {
      sourceRefs: rows.map((row) => row.id),
    },
  );
}

export function workspaceLayerFromSnapshot(row: WorkspaceSnapshotRow): ConfigLayer {
  return layer("workspace", row.id, parse(LayerValuesSchema, row.values, "workspace values"), {
    version: row.version,
    sourceRefs: [row.id],
    lockedFields: parse(LockArraySchema, row.lockedFields, "workspace lockedFields"),
  });
}

export function workspaceLayerFromRequest(
  values: LayerValues,
  lockedFields: readonly string[],
): ConfigLayer {
  return layer("workspace", "request-workspace", values, {
    sourceRefs: ["request"],
    lockedFields,
  });
}

export function videoLayerFromRequest(
  video: LayerValues["video"],
  promptRefs: readonly PromptTemplateReference[] | undefined,
): ConfigLayer | null {
  const values: Record<string, unknown> = {};
  if (video !== undefined) values.video = video;
  if (promptRefs !== undefined && promptRefs.length > 0)
    values.prompt = { templateRefs: [...promptRefs] };
  if (Object.keys(values).length === 0) return null;
  return layer("video", "request-video", values, { sourceRefs: ["request"] });
}
