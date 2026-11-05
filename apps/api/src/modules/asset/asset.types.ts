import type { JsonValue } from "../channel/channel.types.js";

export const ASSET_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "video/mp4",
] as const;

export type AssetMediaType = (typeof ASSET_MEDIA_TYPES)[number];
export type AssetOwnership = "USER_UPLOADED" | "STARTER_LIBRARY" | "SYSTEM_GENERATED";
export type AssetStatus = "PENDING" | "PUBLISHED" | "FAILED" | "ARCHIVED";

export type AssetRights = Readonly<{
  ownership: AssetOwnership;
  rightsHolder: string;
  licenseType: string;
  licenseTerms?: string;
  rightsAttested: boolean;
}>;

export type AssetUploadInput = Readonly<{
  body: Buffer;
  declaredMediaType: string;
  filename: string;
  rights: AssetRights;
}>;

/** A project-owned starter asset that is imported into a workspace on demand. */
export type StarterAssetImport = Readonly<{
  key: string;
  body: Buffer;
  declaredMediaType: string;
  filename: string;
  rightsHolder: string;
  licenseType: string;
  licenseTerms: string;
}>;

export type AssetRecord = Readonly<{
  id: string;
  workspaceId: string;
  objectKey: string;
  mediaType: string;
  filename: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  version: number;
  rootAssetId: string;
  supersedesAssetId: string | null;
  ownership: AssetOwnership;
  status: AssetStatus;
  licenseType: string | null;
  licenseTerms: string | null;
  rightsHolder: string | null;
  rightsAttestedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Immutable asset reference suitable for a future generation job. */
export type AssetReference = Readonly<{
  assetId: string;
  version: number;
  checksumSha256: string;
  objectKey: string;
  mediaType: string;
  byteSize: number;
  ownership: AssetOwnership;
  licenseType: string;
  licenseTerms: string | null;
  rightsHolder: string;
}>;

export type AssetReferenceRequest = Readonly<{
  assetId: string;
  version?: number;
}>;

export type AssetUsageRecord = Readonly<{
  id: string;
  assetId: string;
  assetVersion: number;
  usedByType: string;
  usedById: string;
  context: JsonValue | null;
  createdAt: Date;
}>;
