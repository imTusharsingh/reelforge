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
export class InvalidDtoError extends Error {
  constructor(field: string) {
    super(`The service returned invalid ${field}.`);
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown, label: string): ApiObject {
  if (!isRecord(value)) throw new InvalidDtoError(label);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new InvalidDtoError(label);
  return value;
}
function identifier(value: unknown, label: string): string {
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
function parseSnapshot(value: unknown, workspaceId: string): ApiObject {
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

export function parseDomainResponse(path: string, value: unknown, workspaceId: string): ApiObject {
  return path === "channels" || /^channels\/[^/]+$/.test(path)
    ? parseChannel(value, workspaceId)
    : object(value, "response");
}
