import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { AssetMediaType, AssetOwnership, AssetRights } from "./asset.types.js";
import { sha256Hex } from "./storage/checksum.js";

export const DEFAULT_MAX_ASSET_BYTES = 25 * 1024 * 1024;

export function configuredMaxAssetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.ASSET_MAX_BYTES?.trim();
  if (configured === undefined || configured.length === 0) return DEFAULT_MAX_ASSET_BYTES;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error("ASSET_MAX_BYTES must be a positive integer");
  return parsed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MediaTypeSpec = Readonly<{
  extension: string;
  matches: (body: Buffer) => boolean;
}>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MEDIA_TYPES: Readonly<Record<AssetMediaType, MediaTypeSpec>> = {
  "image/png": {
    extension: "png",
    matches: (body) => body.length >= 8 && body.subarray(0, 8).equals(PNG_SIGNATURE),
  },
  "image/jpeg": {
    extension: "jpg",
    matches: (body) => body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
  },
  "image/webp": {
    extension: "webp",
    matches: (body) =>
      body.length >= 12 &&
      body.toString("ascii", 0, 4) === "RIFF" &&
      body.toString("ascii", 8, 12) === "WEBP",
  },
  "audio/mpeg": {
    extension: "mp3",
    matches: (body) => {
      if (body.length >= 3 && body.toString("ascii", 0, 3) === "ID3") return true;
      const first = body[0];
      const second = body[1];
      return body.length >= 2 && first === 0xff && second !== undefined && (second & 0xe0) === 0xe0;
    },
  },
  "audio/wav": {
    extension: "wav",
    matches: (body) =>
      body.length >= 12 &&
      body.toString("ascii", 0, 4) === "RIFF" &&
      body.toString("ascii", 8, 12) === "WAVE",
  },
  "video/mp4": {
    extension: "mp4",
    matches: (body) => body.length >= 12 && body.toString("ascii", 4, 8) === "ftyp",
  },
};

export type ValidatedUpload = Readonly<{
  mediaType: AssetMediaType;
  byteSize: number;
  checksumSha256: string;
  filename: string;
}>;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function normalizeMediaType(value: unknown): AssetMediaType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.split(";")[0]?.trim().toLowerCase();
  if (normalized === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(MEDIA_TYPES, normalized)
    ? (normalized as AssetMediaType)
    : undefined;
}

export function validateFilename(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new BadRequestException("filename must be a non-empty string");
  if (/[\\/]/.test(value) || value.includes(".."))
    throw new BadRequestException(
      "filename must not contain path separators or traversal segments",
    );
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0)
    throw new BadRequestException("filename must contain visible characters");
  if (cleaned.length > 200)
    throw new BadRequestException("filename must be 200 characters or fewer");
  return cleaned;
}

export function validateUploadPayload(
  input: Readonly<{ body: Buffer; declaredMediaType: string; filename: string }>,
  maxBytes: number = DEFAULT_MAX_ASSET_BYTES,
): ValidatedUpload {
  if (!Buffer.isBuffer(input.body) || input.body.byteLength === 0)
    throw new BadRequestException("Uploaded file is empty");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Asset size limit must be a positive integer");
  if (input.body.byteLength > maxBytes)
    throw new BadRequestException(
      `Uploaded file is ${input.body.byteLength} bytes; the maximum allowed size is ${maxBytes} bytes`,
    );
  const mediaType = normalizeMediaType(input.declaredMediaType);
  if (mediaType === undefined)
    throw new BadRequestException(
      `Unsupported media type "${input.declaredMediaType}". Allowed: image/png, image/jpeg, image/webp, audio/mpeg, audio/wav, video/mp4`,
    );
  if (!MEDIA_TYPES[mediaType].matches(input.body))
    throw new BadRequestException(
      `File content does not match the declared media type ${mediaType}`,
    );
  return {
    mediaType,
    byteSize: input.body.byteLength,
    checksumSha256: sha256Hex(input.body),
    filename: validateFilename(input.filename),
  };
}

export function validateRights(value: unknown): AssetRights {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BadRequestException("Asset rights metadata is required");
  const input = value as Record<string, unknown>;
  const ownership = input.ownership;
  if (
    ownership !== "USER_UPLOADED" &&
    ownership !== "STARTER_LIBRARY" &&
    ownership !== "SYSTEM_GENERATED"
  )
    throw new BadRequestException(
      "ownership must be USER_UPLOADED, STARTER_LIBRARY, or SYSTEM_GENERATED",
    );
  const rightsHolder = requireNonEmptyString(input.rightsHolder, "rightsHolder");
  const licenseType = requireNonEmptyString(input.licenseType, "licenseType");
  const licenseTerms = optionalNonEmptyString(input.licenseTerms, "licenseTerms");
  if (input.rightsAttested !== true)
    throw new BadRequestException(
      "rightsAttested must be true; the uploader must confirm they hold the rights to use this asset",
    );
  return {
    ownership,
    rightsHolder,
    licenseType,
    ...(licenseTerms === undefined ? {} : { licenseTerms }),
    rightsAttested: true,
  };
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new BadRequestException(`${field} must be a non-empty string`);
  return value.trim();
}

export function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNonEmptyString(value, field);
}

export function buildAssetObjectKey(
  rootAssetId: string,
  version: number,
  mediaType: AssetMediaType,
): string {
  if (!isUuid(rootAssetId)) throw new Error("Root asset ID must be a UUID");
  if (!Number.isInteger(version) || version < 1)
    throw new Error("Asset version must be a positive integer");
  return `assets/${rootAssetId}/v${version}/${randomUUID()}.${assetExtension(mediaType)}`;
}

export function assetExtension(mediaType: AssetMediaType): string {
  return MEDIA_TYPES[mediaType].extension;
}

/** Decodes strict base64 for the JSON upload API and rejects malformed input. */
export function decodeBase64Upload(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new BadRequestException("contentBase64 must be a non-empty base64 string");
  const normalized = value.trim();
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized))
    throw new BadRequestException("contentBase64 is not valid base64");
  const body = Buffer.from(normalized, "base64");
  if (body.length === 0) throw new BadRequestException("contentBase64 decodes to an empty file");
  if (body.toString("base64") !== normalized)
    throw new BadRequestException("contentBase64 is not canonical base64");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Asset size limit must be a positive integer");
  if (body.byteLength > maxBytes)
    throw new BadRequestException(
      `Uploaded file is ${body.byteLength} bytes; the maximum allowed size is ${maxBytes} bytes`,
    );
  return body;
}

export function ownershipFromUnknown(value: unknown): AssetOwnership | undefined {
  return value === "USER_UPLOADED" || value === "STARTER_LIBRARY" || value === "SYSTEM_GENERATED"
    ? value
    : undefined;
}
