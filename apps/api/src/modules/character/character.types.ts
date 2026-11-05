import type { JsonValue } from "../channel/channel.types.js";
import type { AssetReference, AssetReferenceRequest } from "../asset/asset.types.js";

export type CharacterStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type CharacterVersionStatus = "DRAFT" | "PUBLISHED";

/** Mutable profile fields for a character draft head. */
export type CharacterProfile = Readonly<{
  name: string;
  description: string | null;
  personality: JsonValue;
  voicePreference: JsonValue;
  visualInvariants: JsonValue;
  variationRules: JsonValue;
}>;

export type CharacterInput = Readonly<{
  name: string;
  description?: string;
  personality: JsonValue;
  voicePreference: JsonValue;
  visualInvariants: JsonValue;
  variationRules: JsonValue;
  referenceAssets: readonly AssetReferenceRequest[];
}>;

export type CharacterCreateInput = Readonly<{
  templateKey?: string;
  name?: string;
  description?: string;
  personality?: JsonValue;
  voicePreference?: JsonValue;
  visualInvariants?: JsonValue;
  variationRules?: JsonValue;
  referenceAssets: readonly AssetReferenceRequest[];
}>;

export type CharacterPatch = Readonly<{
  name?: string;
  description?: string | null;
  personality?: JsonValue;
  voicePreference?: JsonValue;
  visualInvariants?: JsonValue;
  variationRules?: JsonValue;
  referenceAssets?: readonly AssetReferenceRequest[];
}>;

export type CharacterTemplateSummary = Readonly<{
  id: string;
  key: string;
  name: string;
  description: string;
  personality: JsonValue;
  voicePreference: JsonValue;
  visualInvariants: JsonValue;
  variationRules: JsonValue;
  starterAssetKey: string | null;
  rightsHolder: string;
  licenseType: string;
  licenseTerms: string;
}>;

export type CharacterVersionRecord = Readonly<{
  id: string;
  workspaceId: string;
  characterId: string;
  version: number;
  status: CharacterVersionStatus;
  profile: CharacterProfile;
  referenceAssets: readonly AssetReferenceRequest[];
  checksumSha256: string;
  createdByUserId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}>;

/** Immutable reference package for a future generation job. */
export type CharacterReferencePackage = Readonly<{
  characterId: string;
  characterVersionId: string;
  version: number;
  checksumSha256: string;
  profile: CharacterProfile;
  assets: readonly AssetReference[];
  publishedAt: Date | null;
}>;

export type CharacterGroupInput = Readonly<{
  name: string;
  description?: string;
}>;

export type CharacterGroupPatch = Readonly<{
  name?: string;
  description?: string | null;
}>;

export type CharacterGroupMemberInput = Readonly<{
  characterId: string;
  characterVersionId: string;
}>;

export type CharacterGroupAssignmentInput = Readonly<{
  channelId?: string;
  seriesId?: string;
}>;

export type CharacterGroupReferencePackage = Readonly<{
  groupId: string;
  groupName: string;
  members: readonly CharacterReferencePackage[];
  assignments: readonly Readonly<{ channelId: string | null; seriesId: string | null }>[];
}>;
