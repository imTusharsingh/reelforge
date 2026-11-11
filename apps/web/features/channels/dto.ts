/** Feature-owned representations of the inspected M02–M05 read contracts. */
import { isRecord, type ApiObject } from "./model";
export type ChannelDto = {
  id: string;
  workspaceId: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  handle?: string | null;
  description?: string | null;
  niche?: string | null;
  language?: string | null;
  audience?: string | null;
  timezone?: string | null;
  activeSnapshotId?: string | null;
};
export type GenreDto = {
  id: string;
  workspaceId?: string;
  name: string;
  audience: string;
  tone: string;
  language: string;
  topicsAllowed: unknown[];
  topicsBlocked: unknown[];
  structure: ApiObject;
  durationPreference: ApiObject;
  safetyProfile: ApiObject;
};
export type SeriesDto = {
  id: string;
  workspaceId: string;
  channelId: string;
  genreId: string;
  name: string;
  format: string;
  frequency: string;
  characterGroupRefs: unknown[];
  promptRefs: unknown[];
};
export type AssetReferenceDto = { assetId: string; version?: number };
export type CharacterDto = {
  id: string;
  workspaceId?: string;
  name: string;
  description?: string | null;
  personality: ApiObject;
  voicePreference: ApiObject;
  visualInvariants: ApiObject;
  variationRules: ApiObject;
  referenceAssets?: AssetReferenceDto[];
  status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
};
export type CharacterVersionDto = {
  id: string;
  workspaceId: string;
  characterId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  profile: ApiObject;
  referenceAssets: AssetReferenceDto[];
  checksumSha256: string;
};
export type AssetDto = {
  id: string;
  workspaceId: string;
  version: number;
  rootAssetId: string;
  mediaType: string;
  status: "PENDING" | "PUBLISHED" | "FAILED" | "ARCHIVED";
  filename: string | null;
  checksumSha256: string | null;
  byteSize: number | null;
};
export type GroupMemberDto = {
  id: string;
  workspaceId: string;
  groupId: string;
  characterId: string;
  characterVersionId: string;
};
export type GroupAssignmentDto = {
  id: string;
  workspaceId: string;
  groupId: string;
  channelId: string | null;
  seriesId: string | null;
};
export type GroupDto = {
  id: string;
  workspaceId: string;
  name: string;
  members?: GroupMemberDto[];
  assignments?: GroupAssignmentDto[];
};
export type SnapshotDto = {
  id: string;
  version: number;
  workspaceId?: string;
  channelId?: string | null;
  config?: ApiObject;
  values?: ApiObject;
};
export type PromptVersionDto = {
  id: string;
  workspaceId: string;
  templateId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  body: ApiObject;
  checksumSha256: string;
};
export type PromptTemplateDto = {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  activeVersionId: string | null;
  activeVersion?: PromptVersionDto | null;
};
export class InvalidDtoError extends Error {
  constructor(field: string) {
    super(`The service returned invalid ${field}.`);
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function object(value: unknown, label: string): ApiObject {
  if (!isRecord(value)) throw new InvalidDtoError(label);
  return value;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new InvalidDtoError(label);
  return value;
}
export function identifier(value: unknown, label: string): string {
  const id = string(value, label);
  if (!uuid.test(id)) throw new InvalidDtoError(label);
  return id;
}
function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new InvalidDtoError(label);
  return value;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new InvalidDtoError(label);
  return value;
}
function checksum(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[0-9a-f]{64}$/i.test(result)) throw new InvalidDtoError(label);
  return result;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = allowed.find((item) => item === value);
  if (!match) throw new InvalidDtoError(label);
  return match;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidDtoError(label);
  return value;
}
function strings(value: unknown, label: string): string[] {
  return array(value, label).map((v) => string(v, label));
}
function scope(row: ApiObject, workspaceId: string, required = true): void {
  if ((required || row.workspaceId !== undefined) && row.workspaceId !== workspaceId)
    throw new InvalidDtoError("workspace ownership");
}
function optionalTextFields(row: ApiObject, keys: readonly string[]): void {
  for (const key of keys) if (row[key] !== undefined) nullableString(row[key], key);
}
export function parseChannel(value: unknown, workspaceId: string): ChannelDto {
  const row = object(value, "channel");
  scope(row, workspaceId);
  optionalTextFields(row, [
    "handle",
    "description",
    "niche",
    "language",
    "audience",
    "timezone",
    "activeSnapshotId",
  ]);
  if (row.activeSnapshot !== undefined && row.activeSnapshot !== null) {
    const snap = object(row.activeSnapshot, "active channel snapshot");
    scope(snap, workspaceId);
    if (snap.channelId !== row.id) throw new InvalidDtoError("active snapshot channel");
    parseSnapshot(snap, workspaceId);
  }
  return {
    ...row,
    id: identifier(row.id, "channel id"),
    workspaceId,
    name: string(row.name, "channel name"),
    status: enumeration(row.status, ["ACTIVE", "PAUSED", "ARCHIVED"], "channel status"),
  };
}
export function parseGenre(value: unknown, workspaceId: string, template = false): GenreDto {
  const row = object(value, "genre");
  scope(row, workspaceId, !template);
  return {
    ...row,
    id: identifier(row.id, "genre id"),
    name: string(row.name, "genre name"),
    audience: string(row.audience, "genre audience"),
    tone: string(row.tone, "genre tone"),
    language: string(row.language, "genre language"),
    topicsAllowed: array(row.topicsAllowed, "allowed topics"),
    topicsBlocked: array(row.topicsBlocked, "blocked topics"),
    structure: object(row.structure, "story structure"),
    durationPreference: object(row.durationPreference, "duration preferences"),
    safetyProfile: object(row.safetyProfile, "safety profile"),
  };
}
export function parseSeries(value: unknown, workspaceId: string, channelId: string): SeriesDto {
  const row = object(value, "series");
  scope(row, workspaceId);
  if (row.channelId !== channelId) throw new InvalidDtoError("series channel");
  return {
    ...row,
    id: identifier(row.id, "series id"),
    workspaceId,
    channelId,
    genreId: identifier(row.genreId, "series genre"),
    name: string(row.name, "series name"),
    format: string(row.format, "series format"),
    frequency: string(row.frequency, "series frequency"),
    characterGroupRefs: array(row.characterGroupRefs, "character group references"),
    promptRefs: array(row.promptRefs, "prompt references"),
  };
}
export function parseAssetReference(value: unknown): AssetReferenceDto {
  const row = object(value, "asset reference");
  return {
    assetId: identifier(row.assetId, "asset reference id"),
    ...(row.version === undefined
      ? {}
      : { version: positive(row.version, "asset reference version") }),
  };
}
export function parseCharacter(
  value: unknown,
  workspaceId: string,
  template = false,
): CharacterDto {
  const row = object(value, "character");
  scope(row, workspaceId, !template);
  optionalTextFields(row, ["description"]);
  const profile = {
    personality: object(row.personality, "personality"),
    voicePreference: object(row.voicePreference, "voice preferences"),
    visualInvariants: object(row.visualInvariants, "visual invariants"),
    variationRules: object(row.variationRules, "variation rules"),
  };
  if (row.activeVersion !== undefined && row.activeVersion !== null)
    parseCharacterVersion(row.activeVersion, workspaceId, String(row.id));
  return {
    ...row,
    ...profile,
    id: identifier(row.id, "character id"),
    name: string(row.name, "character name"),
    ...(template
      ? {}
      : {
          status: enumeration(row.status, ["DRAFT", "PUBLISHED", "ARCHIVED"], "character status"),
          referenceAssets: array(row.referenceAssets, "character assets").map(parseAssetReference),
        }),
  };
}
export function parseCharacterVersion(
  value: unknown,
  workspaceId: string,
  characterId: string,
): CharacterVersionDto {
  const row = object(value, "character version");
  scope(row, workspaceId);
  if (row.characterId !== characterId) throw new InvalidDtoError("version character");
  const profile = object(row.profile, "published profile");
  string(profile.name, "published character name");
  for (const key of ["personality", "voicePreference", "visualInvariants", "variationRules"])
    object(profile[key], `published ${key}`);
  return {
    ...row,
    id: identifier(row.id, "character version id"),
    workspaceId,
    characterId,
    version: positive(row.version, "character version"),
    status: enumeration(row.status, ["DRAFT", "PUBLISHED"], "character version status"),
    profile,
    referenceAssets: array(row.referenceAssets, "published asset references").map(
      parseAssetReference,
    ),
    checksumSha256: checksum(row.checksumSha256, "character checksum"),
  };
}
export function parseAsset(value: unknown, workspaceId: string): AssetDto {
  const row = object(value, "asset");
  scope(row, workspaceId);
  if (
    row.byteSize !== null &&
    (typeof row.byteSize !== "number" || !Number.isSafeInteger(row.byteSize) || row.byteSize < 0)
  )
    throw new InvalidDtoError("asset size");
  return {
    ...row,
    id: identifier(row.id, "asset id"),
    workspaceId,
    rootAssetId: identifier(row.rootAssetId, "root asset id"),
    version: positive(row.version, "asset version"),
    mediaType: string(row.mediaType, "asset media type"),
    status: enumeration(row.status, ["PENDING", "PUBLISHED", "FAILED", "ARCHIVED"], "asset status"),
    filename: nullableString(row.filename, "filename"),
    byteSize: row.byteSize,
    checksumSha256:
      row.checksumSha256 === null ? null : checksum(row.checksumSha256, "asset checksum"),
  };
}
export function parseMember(value: unknown, workspaceId: string, groupId: string): GroupMemberDto {
  const row = object(value, "group member");
  scope(row, workspaceId);
  if (row.groupId !== groupId) throw new InvalidDtoError("member group");
  const result = {
    ...row,
    id: identifier(row.id, "member id"),
    workspaceId,
    groupId,
    characterId: identifier(row.characterId, "member character"),
    characterVersionId: identifier(row.characterVersionId, "member version"),
  };
  if (row.character !== undefined) parseCharacter(row.character, workspaceId);
  if (row.characterVersion !== undefined) {
    const version = parseCharacterVersion(row.characterVersion, workspaceId, result.characterId);
    if (version.id !== result.characterVersionId || version.status !== "PUBLISHED")
      throw new InvalidDtoError("pinned member version");
  }
  return result;
}
export function parseAssignment(
  value: unknown,
  workspaceId: string,
  groupId: string,
): GroupAssignmentDto {
  const row = object(value, "group assignment");
  scope(row, workspaceId);
  if (row.groupId !== groupId) throw new InvalidDtoError("assignment group");
  const channelId = row.channelId === null ? null : identifier(row.channelId, "assigned channel");
  const seriesId = row.seriesId === null ? null : identifier(row.seriesId, "assigned series");
  if ((channelId === null) === (seriesId === null)) throw new InvalidDtoError("assignment target");
  return {
    ...row,
    id: identifier(row.id, "assignment id"),
    workspaceId,
    groupId,
    channelId,
    seriesId,
  };
}
export function parseGroup(value: unknown, workspaceId: string): GroupDto {
  const row = object(value, "character group");
  scope(row, workspaceId);
  const id = identifier(row.id, "group id");
  return {
    ...row,
    id,
    workspaceId,
    name: string(row.name, "group name"),
    ...(row.members === undefined
      ? {}
      : {
          members: array(row.members, "group members").map((v) => parseMember(v, workspaceId, id)),
        }),
    ...(row.assignments === undefined
      ? {}
      : {
          assignments: array(row.assignments, "group assignments").map((v) =>
            parseAssignment(v, workspaceId, id),
          ),
        }),
  };
}
export function parseSnapshot(value: unknown, workspaceId: string): SnapshotDto {
  const row = object(value, "snapshot");
  scope(row, workspaceId, false);
  if (row.config !== undefined) object(row.config, "snapshot configuration");
  if (row.values !== undefined) object(row.values, "workspace snapshot values");
  if (row.lockedFields !== undefined) strings(row.lockedFields, "locked fields");
  return {
    ...row,
    id: identifier(row.id, "snapshot id"),
    version: positive(row.version, "snapshot version"),
  };
}
export function parsePromptVersion(
  value: unknown,
  workspaceId: string,
  templateId: string,
): PromptVersionDto {
  const row = object(value, "prompt version");
  scope(row, workspaceId);
  if (row.templateId !== templateId) throw new InvalidDtoError("prompt template ownership");
  const body = object(row.body, "prompt version body");
  string(object(body.sections, "prompt sections").instructions, "prompt instructions");
  array(body.variables, "prompt variables").forEach((v) => {
    const variable = object(v, "prompt variable");
    string(variable.name, "variable name");
    if (typeof variable.required !== "boolean") throw new InvalidDtoError("required variable flag");
  });
  strings(body.allowedAdditionSections, "allowed additions");
  return {
    ...row,
    id: identifier(row.id, "prompt version id"),
    workspaceId,
    templateId,
    version: positive(row.version, "prompt version"),
    status: enumeration(row.status, ["DRAFT", "PUBLISHED"], "prompt status"),
    body,
    checksumSha256: checksum(row.checksumSha256, "prompt checksum"),
  };
}
export function parsePromptTemplate(value: unknown, workspaceId: string): PromptTemplateDto {
  const row = object(value, "prompt template");
  scope(row, workspaceId);
  const id = identifier(row.id, "prompt template id");
  const activeVersionId =
    row.activeVersionId === null
      ? null
      : identifier(row.activeVersionId, "active prompt version id");
  const active =
    row.activeVersion === undefined
      ? undefined
      : row.activeVersion === null
        ? null
        : parsePromptVersion(row.activeVersion, workspaceId, id);
  if (active && active.id !== activeVersionId) throw new InvalidDtoError("active prompt version");
  return {
    ...row,
    id,
    workspaceId,
    name: string(row.name, "template name"),
    key: string(row.key, "template key"),
    activeVersionId,
    ...(active === undefined ? {} : { activeVersion: active }),
  };
}
export function parseDomainResponse(path: string, value: unknown, workspaceId: string): ApiObject {
  const parts = path.split("/").map(decodeURIComponent);
  const root = parts[0];
  if (root === "channels") {
    if (parts[2] === "series") return parseSeries(value, workspaceId, parts[1]!);
    if (parts[2] === "snapshots" && parts[4] !== "select") {
      const snapshot = parseSnapshot(value, workspaceId);
      if (snapshot.channelId !== parts[1]) throw new InvalidDtoError("snapshot channel");
      return snapshot;
    }
    return parseChannel(value, workspaceId);
  }
  if (root === "genres" || root === "genre-templates")
    return parseGenre(value, workspaceId, root === "genre-templates");
  if (root === "character-templates") return parseCharacter(value, workspaceId, true);
  if (root === "characters") {
    if (parts[2] === "versions" || parts[2] === "publish")
      return parseCharacterVersion(value, workspaceId, parts[1]!);
    if (parts[2] !== "reference-package") return parseCharacter(value, workspaceId);
    const row = object(value, "character reference package");
    if (row.characterId !== parts[1]) throw new InvalidDtoError("reference character");
    identifier(row.characterVersionId, "reference version");
    positive(row.version, "reference version number");
    checksum(row.checksumSha256, "reference checksum");
    array(row.assets, "reference assets").forEach(parseAssetReference);
    return row;
  }
  if (root === "assets" && parts[2] !== "usage") return parseAsset(value, workspaceId);
  if (root === "character-groups") {
    if (parts[2] === "members") return parseMember(value, workspaceId, parts[1]!);
    if (parts[2] === "assignments") return parseAssignment(value, workspaceId, parts[1]!);
    if (parts[2] !== "reference-package") return parseGroup(value, workspaceId);
    const row = object(value, "group reference package");
    if (row.groupId !== parts[1]) throw new InvalidDtoError("reference group");
    array(row.members, "group reference members").forEach((v) => {
      const member = object(v, "group reference member");
      identifier(member.characterId, "reference character");
      identifier(member.characterVersionId, "reference version");
      array(member.assets, "reference assets").forEach(parseAssetReference);
    });
    return row;
  }
  if (root === "prompts" && parts[1] === "templates")
    return parts[3] === "versions" || parts[3] === "rollback"
      ? parsePromptVersion(value, workspaceId, parts[2]!)
      : parsePromptTemplate(value, workspaceId);
  if (
    (root === "config" && ["snapshots", "generation-snapshots"].includes(parts[1] ?? "")) ||
    (root === "prompts" && parts[1] === "bundle-snapshots")
  )
    return parseSnapshot(value, workspaceId);
  const row = object(value, "response");
  scope(row, workspaceId, false);
  return row;
}
