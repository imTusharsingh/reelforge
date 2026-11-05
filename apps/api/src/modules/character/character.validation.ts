import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { JsonValue } from "../channel/channel.types.js";
import type { AssetReferenceRequest } from "../asset/asset.types.js";
import { isUuid } from "../asset/asset.validation.js";
import type {
  CharacterCreateInput,
  CharacterGroupAssignmentInput,
  CharacterGroupInput,
  CharacterGroupMemberInput,
  CharacterGroupPatch,
  CharacterInput,
  CharacterPatch,
  CharacterProfile,
} from "./character.types.js";

const MAX_REFERENCE_ASSETS = 50;

function bodyObject(body: unknown, label: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new BadRequestException(`${label} body must be an object`);
  return body as Record<string, unknown>;
}

export function requireText(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new BadRequestException(`${field} must be a non-empty string`);
  const cleaned = value.trim();
  if (cleaned.length > maxLength)
    throw new BadRequestException(`${field} must be ${maxLength} characters or fewer`);
  return cleaned;
}

function optionalText(value: unknown, field: string, maxLength = 4000): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new BadRequestException(`${field} must be a string when provided`);
  const cleaned = value.trim();
  if (cleaned.length > maxLength)
    throw new BadRequestException(`${field} must be ${maxLength} characters or fewer`);
  return cleaned.length === 0 ? undefined : cleaned;
}

/** Validates a JSON value and rejects values that cannot round-trip through JSON. */
export function requireJsonValue(value: unknown, field: string, depth = 0): JsonValue {
  if (depth > 20) throw new BadRequestException(`${field} is nested too deeply`);
  if (value === null) throw new BadRequestException(`${field} must not be null`);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new BadRequestException(`${field} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500)
      throw new BadRequestException(`${field} must contain 500 items or fewer`);
    return value.map((item, index) => requireJsonValue(item, `${field}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined)
        throw new BadRequestException(`${field}.${key} must not be undefined`);
      result[key] = requireJsonValue(item, `${field}.${key}`, depth + 1);
    }
    return result;
  }
  throw new BadRequestException(`${field} must be a JSON value`);
}

function requireJsonObject(value: unknown, field: string): JsonValue {
  const parsed = requireJsonValue(value, field);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new BadRequestException(`${field} must be a JSON object`);
  return parsed;
}

function referenceAssets(value: unknown): readonly AssetReferenceRequest[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException("referenceAssets must be an array");
  if (value.length > MAX_REFERENCE_ASSETS)
    throw new BadRequestException(
      `referenceAssets must contain ${MAX_REFERENCE_ASSETS} items or fewer`,
    );
  const seen = new Set<string>();
  const result: AssetReferenceRequest[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new BadRequestException(`referenceAssets[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    if (!isUuid(record.assetId))
      throw new BadRequestException(`referenceAssets[${index}].assetId must be a UUID`);
    if (
      record.version !== undefined &&
      (typeof record.version !== "number" ||
        !Number.isInteger(record.version) ||
        record.version < 1)
    )
      throw new BadRequestException(
        `referenceAssets[${index}].version must be a positive integer when provided`,
      );
    const key = `${record.assetId}@${record.version ?? "latest"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      assetId: record.assetId,
      ...(record.version === undefined ? {} : { version: record.version }),
    });
  }
  return result;
}

export function validateCharacterCreate(body: unknown): CharacterCreateInput {
  const input = bodyObject(body, "Character");
  const templateKey =
    input.templateKey === undefined || input.templateKey === null
      ? undefined
      : requireText(input.templateKey, "templateKey", 120);
  const name =
    input.name === undefined || input.name === null
      ? undefined
      : requireText(input.name, "name", 120);
  const description = optionalText(input.description, "description");
  const personality =
    input.personality === undefined || input.personality === null
      ? undefined
      : requireJsonObject(input.personality, "personality");
  const voicePreference =
    input.voicePreference === undefined || input.voicePreference === null
      ? undefined
      : requireJsonObject(input.voicePreference, "voicePreference");
  const visualInvariants =
    input.visualInvariants === undefined || input.visualInvariants === null
      ? undefined
      : requireJsonObject(input.visualInvariants, "visualInvariants");
  const variationRules =
    input.variationRules === undefined || input.variationRules === null
      ? undefined
      : requireJsonObject(input.variationRules, "variationRules");
  const refs = referenceAssets(input.referenceAssets);
  if (templateKey === undefined) {
    if (name === undefined) throw new BadRequestException("name must be provided");
    if (personality === undefined)
      throw new BadRequestException("personality is required for a custom character");
    if (voicePreference === undefined)
      throw new BadRequestException("voicePreference is required for a custom character");
    if (visualInvariants === undefined)
      throw new BadRequestException("visualInvariants is required for a custom character");
    if (variationRules === undefined)
      throw new BadRequestException("variationRules is required for a custom character");
  }
  return {
    ...(templateKey === undefined ? {} : { templateKey }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(personality === undefined ? {} : { personality }),
    ...(voicePreference === undefined ? {} : { voicePreference }),
    ...(visualInvariants === undefined ? {} : { visualInvariants }),
    ...(variationRules === undefined ? {} : { variationRules }),
    referenceAssets: refs,
  };
}

export function validateCharacterPatch(body: unknown): CharacterPatch {
  const input = bodyObject(body, "Character");
  const name =
    input.name === undefined || input.name === null
      ? undefined
      : requireText(input.name, "name", 120);
  const description =
    input.description === null
      ? null
      : input.description === undefined
        ? undefined
        : optionalText(input.description, "description");
  const personality =
    input.personality === undefined || input.personality === null
      ? undefined
      : requireJsonObject(input.personality, "personality");
  const voicePreference =
    input.voicePreference === undefined || input.voicePreference === null
      ? undefined
      : requireJsonObject(input.voicePreference, "voicePreference");
  const visualInvariants =
    input.visualInvariants === undefined || input.visualInvariants === null
      ? undefined
      : requireJsonObject(input.visualInvariants, "visualInvariants");
  const variationRules =
    input.variationRules === undefined || input.variationRules === null
      ? undefined
      : requireJsonObject(input.variationRules, "variationRules");
  const refs =
    input.referenceAssets === undefined ? undefined : referenceAssets(input.referenceAssets);
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(personality === undefined ? {} : { personality }),
    ...(voicePreference === undefined ? {} : { voicePreference }),
    ...(visualInvariants === undefined ? {} : { visualInvariants }),
    ...(variationRules === undefined ? {} : { variationRules }),
    ...(refs === undefined ? {} : { referenceAssets: refs }),
  };
}

export function validateCharacterInput(input: CharacterCreateInput): CharacterInput {
  return {
    name: input.name ?? "",
    ...(input.description === undefined ? {} : { description: input.description }),
    personality: input.personality ?? {},
    voicePreference: input.voicePreference ?? {},
    visualInvariants: input.visualInvariants ?? {},
    variationRules: input.variationRules ?? {},
    referenceAssets: input.referenceAssets ?? [],
  };
}

export function validateGroupInput(body: unknown): CharacterGroupInput {
  const input = bodyObject(body, "Character group");
  return {
    name: requireText(input.name, "name", 120),
    ...(optionalText(input.description, "description") === undefined
      ? {}
      : { description: optionalText(input.description, "description") as string }),
  };
}

export function validateGroupPatch(body: unknown): CharacterGroupPatch {
  const input = bodyObject(body, "Character group");
  const name =
    input.name === undefined || input.name === null
      ? undefined
      : requireText(input.name, "name", 120);
  const description =
    input.description === null
      ? null
      : input.description === undefined
        ? undefined
        : optionalText(input.description, "description");
  if (name === undefined && description === undefined)
    throw new BadRequestException("At least one group field must be provided");
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

export function validateGroupMember(body: unknown): CharacterGroupMemberInput {
  const input = bodyObject(body, "Character group member");
  if (!isUuid(input.characterId)) throw new BadRequestException("characterId must be a UUID");
  if (!isUuid(input.characterVersionId))
    throw new BadRequestException("characterVersionId must be a UUID");
  return { characterId: input.characterId, characterVersionId: input.characterVersionId };
}

export function validateGroupAssignment(body: unknown): CharacterGroupAssignmentInput {
  const input = bodyObject(body, "Character group assignment");
  const channelId = input.channelId;
  const seriesId = input.seriesId;
  if (channelId !== undefined && channelId !== null && !isUuid(channelId))
    throw new BadRequestException("channelId must be a UUID when provided");
  if (seriesId !== undefined && seriesId !== null && !isUuid(seriesId))
    throw new BadRequestException("seriesId must be a UUID when provided");
  const hasChannel = typeof channelId === "string";
  const hasSeries = typeof seriesId === "string";
  if (hasChannel === hasSeries)
    throw new BadRequestException(
      "A group assignment must target exactly one of channelId or seriesId",
    );
  return hasChannel ? { channelId: channelId as string } : { seriesId: seriesId as string };
}

export function profileFromRow(row: {
  name: string;
  description: string | null;
  personality: unknown;
  voicePreference: unknown;
  visualInvariants: unknown;
  variationRules: unknown;
}): CharacterProfile {
  return {
    name: row.name,
    description: row.description,
    personality: requireJsonValue(row.personality, "personality"),
    voicePreference: requireJsonValue(row.voicePreference, "voicePreference"),
    visualInvariants: requireJsonValue(row.visualInvariants, "visualInvariants"),
    variationRules: requireJsonValue(row.variationRules, "variationRules"),
  };
}

export function profileFromJson(value: unknown): CharacterProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Persisted character profile is not an object");
  const input = value as Record<string, unknown>;
  const name = input.name;
  const description = input.description;
  if (typeof name !== "string" || name.length === 0)
    throw new Error("Persisted character profile is missing a name");
  if (description !== null && typeof description !== "string")
    throw new Error("Persisted character profile has an invalid description");
  return {
    name,
    description,
    personality: requireJsonValue(input.personality, "personality"),
    voicePreference: requireJsonValue(input.voicePreference, "voicePreference"),
    visualInvariants: requireJsonValue(input.visualInvariants, "visualInvariants"),
    variationRules: requireJsonValue(input.variationRules, "variationRules"),
  };
}

export function persistedReferenceAssets(value: unknown): readonly AssetReferenceRequest[] {
  return referenceAssets(value);
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  return value;
}

export function characterSnapshotChecksum(
  profile: CharacterProfile,
  references: readonly AssetReferenceRequest[],
): string {
  const payload = canonicalize({
    profile: {
      name: profile.name,
      description: profile.description,
      personality: profile.personality,
      voicePreference: profile.voicePreference,
      visualInvariants: profile.visualInvariants,
      variationRules: profile.variationRules,
    },
    referenceAssets: references.map((reference) => ({
      assetId: reference.assetId,
      version: reference.version ?? "latest",
    })),
  } as JsonValue);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
