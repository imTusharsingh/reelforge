export type ApiObject = Record<string, unknown>;
export type Role = "OWNER" | "EDITOR" | "VIEWER" | "UNKNOWN";
export type { ChannelDto as Channel } from "./dto";
import type { ChannelDto as Channel } from "./dto";
export const roleNotice =
  "Your workspace role is unavailable. Changes require a verified owner or editor role; editing is disabled until Core exposes trusted membership information.";
export const canEdit = (role: Role): boolean => role === "OWNER" || role === "EDITOR";
export function isRecord(value: unknown): value is ApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function text(value: unknown, fallback = "Not set"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
export const pretty = (value: unknown): string => JSON.stringify(value ?? null, null, 2);
export function parseObject(value: string): ApiObject {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Enter a JSON object.");
  return parsed;
}
export function filterChannels(channels: Channel[], query: string, status: string): Channel[] {
  return channels.filter(
    (c) =>
      (status === "ALL" || c.status === status) &&
      [c.name, c.handle, c.niche]
        .map((v) => text(v, ""))
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
}
export function channelPayload(values: ApiObject): ApiObject {
  const result: ApiObject = {};
  for (const key of [
    "name",
    "handle",
    "description",
    "niche",
    "language",
    "audience",
    "timezone",
  ]) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) result[key] = value.trim();
  }
  if (!result.name) throw new Error("Enter a channel name.");
  if (result.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(result.timezone) }).format();
    } catch {
      throw new Error("Enter a valid IANA timezone.");
    }
  }
  return result;
}
export type CommonField = {
  key: string;
  label: string;
  kind?: "text" | "number" | "lines" | "boolean" | "time";
  choices?: readonly string[];
};
export type FieldSpec = {
  key: string;
  label: string;
  kind?: "text" | "object" | "array" | "number" | "lines";
  common?: readonly CommonField[];
  optional?: boolean;
  hint?: string;
};
export function formPayload(
  fields: readonly FieldSpec[],
  values: Record<string, string>,
): ApiObject {
  const result: ApiObject = {};
  for (const field of fields) {
    const value = (values[field.key] ?? "").trim();
    if (!value && field.optional) continue;
    if (!value && field.kind !== "lines") throw new Error(`${field.label} is required.`);
    if (field.kind === "lines") {
      result[field.key] = value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (field.kind === "object" || field.kind === "array") {
      const parsed: unknown = JSON.parse(value);
      if (field.kind === "array" ? !Array.isArray(parsed) : !isRecord(parsed))
        throw new Error(`${field.label} must be a JSON ${field.kind}.`);
      result[field.key] = parsed;
    } else if (field.kind === "number") {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1)
        throw new Error(`${field.label} must be a positive integer.`);
      result[field.key] = n;
    } else result[field.key] = value;
  }
  return result;
}

export function initialFormValues(
  fields: readonly FieldSpec[],
  initial: ApiObject,
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = initial[field.key];
      return [
        field.key,
        value === undefined || value === null
          ? field.kind === "object"
            ? "{}"
            : field.kind === "array"
              ? "[]"
              : ""
          : field.kind === "lines" && Array.isArray(value)
            ? value.join("\n")
            : typeof value === "string"
              ? value
              : pretty(value),
      ];
    }),
  );
}
