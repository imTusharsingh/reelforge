import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Response } from "express";
import { ASSET_MEDIA_TYPES } from "./asset.types.js";
import { sha256Hex } from "./storage/checksum.js";
import { StorageObjectNotFoundError } from "./storage/storage.port.js";
import type { StoragePort } from "./storage/storage.port.js";

export type MediaContent = Readonly<{
  body: Buffer;
  mediaType: string;
  filename: string;
  byteSize: number;
  checksumSha256: string;
  cacheControl: string;
}>;

export type RangeResult =
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "partial"; start: number; end: number }>
  | Readonly<{ kind: "unsatisfiable" }>;

const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "application/json": "json",
};

const DELIVERABLE_MEDIA_TYPES = new Set<string>([...ASSET_MEDIA_TYPES, "application/json"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FILENAME_LENGTH = 200;

export const IMMUTABLE_ASSET_CACHE_CONTROL = "private, max-age=31536000, immutable";
export const EXPIRING_ARTIFACT_CACHE_CONTROL = "private, no-store";

/** Returns the normalized persisted media type only when it is safe to deliver. */
export function deliverableMediaType(value: string): string | undefined {
  const normalized = value.split(";")[0]?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  return DELIVERABLE_MEDIA_TYPES.has(normalized) ? normalized : undefined;
}

export function defaultContentFilename(mediaType: string, stem: string): string {
  const extension = MEDIA_EXTENSIONS[mediaType];
  if (extension === undefined) throw new Error(`No safe filename extension for ${mediaType}`);
  return `${stem}.${extension}`;
}

/** Sanitizes persisted filenames before they reach Content-Disposition. */
export function sanitizeContentFilename(
  value: string | null | undefined,
  fallback: string,
): string {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseDownloadQuery(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "string")
    throw new BadRequestException("download must be the string true or false");
  const normalized = value.trim().toLowerCase();
  if (normalized === "false" || normalized === "") return false;
  if (normalized === "true") return true;
  throw new BadRequestException("download must be the string true or false");
}

export function parsePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new BadRequestException(`${field} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new BadRequestException(`${field} must be a positive integer`);
  return parsed;
}

/**
 * Parses one HTTP byte range. Multi-range requests are rejected rather than
 * multipart-encoded. An If-Range value that does not match the exact ETag is
 * ignored so the caller receives the full representation.
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  size: number,
  etag: string,
  ifRangeHeader?: string,
): RangeResult {
  if (rangeHeader === undefined || rangeHeader.trim().length === 0) return { kind: "full" };
  if (
    ifRangeHeader !== undefined &&
    ifRangeHeader.trim().length > 0 &&
    ifRangeHeader.trim() !== etag
  )
    return { kind: "full" };
  const value = rangeHeader.trim();
  if (!value.toLowerCase().startsWith("bytes=")) return { kind: "unsatisfiable" };
  const spec = value.slice("bytes=".length).trim();
  if (spec.includes(",")) return { kind: "unsatisfiable" };
  const match = /^([0-9]*)-([0-9]*)$/.exec(spec);
  if (!match) return { kind: "unsatisfiable" };
  const [, startText = "", endText = ""] = match;
  if (startText.length === 0 && endText.length === 0) return { kind: "unsatisfiable" };
  if (size <= 0) return { kind: "unsatisfiable" };
  if (startText.length === 0) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - suffix);
    return { kind: "partial", start, end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { kind: "unsatisfiable" };
  if (endText.length === 0) return { kind: "partial", start, end: size - 1 };
  const end = Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end: Math.min(end, size - 1) };
}

/** Reads and verifies stored bytes before any success response can be written. */
export async function readVerifiedStorageObject(input: {
  storage: StoragePort;
  workspaceId: string;
  objectKey: string;
  byteSize: number;
  checksumSha256: string;
  label: string;
}): Promise<Buffer> {
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0)
    throw new ConflictException(`${input.label} is missing a valid byte size`);
  if (!SHA256_PATTERN.test(input.checksumSha256))
    throw new ConflictException(`${input.label} is missing a valid checksum`);
  let body: Buffer;
  try {
    body = await input.storage.getObject({
      workspaceId: input.workspaceId,
      objectKey: input.objectKey,
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError)
      throw new NotFoundException(`${input.label} content is not available`);
    throw new ServiceUnavailableException(`${input.label} storage could not be read`, {
      cause: error,
    });
  }
  if (body.byteLength !== input.byteSize || sha256Hex(body) !== input.checksumSha256)
    throw new ConflictException(`${input.label} content failed integrity validation`);
  return body;
}

export type MediaResponseOptions = Readonly<{
  download?: boolean | undefined;
  head?: boolean | undefined;
  rangeHeader?: string | undefined;
  ifRangeHeader?: string | undefined;
}>;

/** Writes the complete response contract, including range and cache semantics. */
export function sendMediaContent(
  response: Response,
  content: MediaContent,
  options: MediaResponseOptions = {},
): void {
  const etag = `"sha256-${content.checksumSha256}"`;
  response.setHeader("Content-Type", content.mediaType);
  response.setHeader(
    "Content-Disposition",
    contentDisposition(options.download === true ? "attachment" : "inline", content.filename),
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", content.cacheControl);

  if (options.head === true) {
    response.status(200);
    response.setHeader("Content-Length", String(content.byteSize));
    response.end();
    return;
  }

  const range = parseRangeHeader(
    options.rangeHeader,
    content.byteSize,
    etag,
    options.ifRangeHeader,
  );
  if (range.kind === "unsatisfiable") {
    response.status(416);
    response.setHeader("Content-Range", `bytes */${content.byteSize}`);
    response.setHeader("Content-Length", "0");
    response.end();
    return;
  }
  if (range.kind === "partial") {
    const body = content.body.subarray(range.start, range.end + 1);
    response.status(206);
    response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${content.byteSize}`);
    response.setHeader("Content-Length", String(body.byteLength));
    response.end(body);
    return;
  }
  response.status(200);
  response.setHeader("Content-Length", String(content.byteSize));
  response.end(content.body);
}
