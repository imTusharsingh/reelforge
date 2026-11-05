import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { JsonValue } from "../channel/channel.types.js";
import type { AssetReference, AssetReferenceRequest } from "../asset/asset.types.js";
import { isUuid } from "../asset/asset.validation.js";
import { AssetService } from "../asset/asset.service.js";
import { starterAssetBody, starterAssetDefinition } from "./starter-assets.js";
import type {
  CharacterCreateInput,
  CharacterGroupAssignmentInput,
  CharacterGroupMemberInput,
  CharacterGroupPatch,
  CharacterGroupReferencePackage,
  CharacterProfile,
  CharacterReferencePackage,
  CharacterVersionRecord,
} from "./character.types.js";
import {
  characterSnapshotChecksum,
  persistedReferenceAssets,
  profileFromJson,
  profileFromRow,
  validateCharacterCreate,
  validateCharacterPatch,
  validateGroupAssignment,
  validateGroupInput,
  validateGroupMember,
  validateGroupPatch,
} from "./character.validation.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);

type CharacterRow = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  personality: unknown;
  voicePreference: unknown;
  visualInvariants: unknown;
  variationRules: unknown;
  referenceAssets: unknown;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  activeVersionId: string | null;
}>;

type CharacterVersionRow = Readonly<{
  id: string;
  workspaceId: string;
  characterId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  profile: unknown;
  referenceAssets: unknown;
  checksumSha256: string;
  createdByUserId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}>;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function dedupeReferences(
  references: readonly AssetReferenceRequest[],
): readonly AssetReferenceRequest[] {
  const seen = new Set<string>();
  const result: AssetReferenceRequest[] = [];
  for (const reference of references) {
    const key = `${reference.assetId}@${reference.version ?? "latest"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

@Injectable()
export class CharacterService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly assets: AssetService,
  ) {}

  private assertCanMutate(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Character mutation requires owner or editor access");
  }

  public templates(): Promise<unknown> {
    return this.db.characterTemplate.findMany({ orderBy: { name: "asc" } });
  }

  public list(context: WorkspaceContext): Promise<unknown> {
    return this.db.character.findMany({
      where: { workspaceId: context.workspaceId },
      include: { activeVersion: true },
      orderBy: { createdAt: "asc" },
    });
  }

  public async get(context: WorkspaceContext, characterId: string): Promise<CharacterRow> {
    if (!isUuid(characterId)) throw new BadRequestException("characterId must be a UUID");
    const character = await this.db.character.findFirst({
      where: { workspaceId: context.workspaceId, id: characterId },
    });
    if (!character) throw new NotFoundException("Character not found");
    return character;
  }

  public async create(context: WorkspaceContext, body: unknown): Promise<unknown> {
    this.assertCanMutate(context);
    const input = validateCharacterCreate(body);
    const template =
      input.templateKey === undefined
        ? null
        : await this.db.characterTemplate.findUnique({ where: { key: input.templateKey } });
    if (input.templateKey !== undefined && !template)
      throw new NotFoundException("Character template not found");

    const profile = this.mergeProfile(input, template);
    const references = await this.attachStarterAsset(
      context,
      template?.starterAssetKey ?? null,
      input.referenceAssets,
    );
    await this.assets.resolveReferences(context, references);
    try {
      const character = await this.db.character.create({
        data: {
          workspaceId: context.workspaceId,
          ...(template === null ? {} : { templateId: template.id }),
          name: profile.name,
          description: profile.description,
          personality: profile.personality as never,
          voicePreference: profile.voicePreference as never,
          visualInvariants: profile.visualInvariants as never,
          variationRules: profile.variationRules as never,
          referenceAssets: references as never,
        },
      });
      return this.get(context, character.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("Character already exists");
      throw error;
    }
  }

  public async update(
    context: WorkspaceContext,
    characterId: string,
    body: unknown,
  ): Promise<unknown> {
    this.assertCanMutate(context);
    const existing = await this.get(context, characterId);
    if (existing.status === "ARCHIVED")
      throw new ConflictException("Archived characters cannot be edited");
    const patch = validateCharacterPatch(body);
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.personality !== undefined) data.personality = patch.personality;
    if (patch.voicePreference !== undefined) data.voicePreference = patch.voicePreference;
    if (patch.visualInvariants !== undefined) data.visualInvariants = patch.visualInvariants;
    if (patch.variationRules !== undefined) data.variationRules = patch.variationRules;
    if (patch.referenceAssets !== undefined) {
      await this.assets.resolveReferences(context, patch.referenceAssets);
      data.referenceAssets = patch.referenceAssets;
    }
    if (Object.keys(data).length === 0)
      throw new BadRequestException("At least one character field must be provided");
    await this.db.character.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: characterId } },
      data: data as never,
    });
    return this.get(context, characterId);
  }

  public async publish(context: WorkspaceContext, characterId: string): Promise<unknown> {
    this.assertCanMutate(context);
    const character = await this.get(context, characterId);
    if (character.status === "ARCHIVED")
      throw new ConflictException("Archived characters cannot be published");
    const profile = profileFromRow(character);
    const draftReferences = persistedReferenceAssets(character.referenceAssets);
    if (draftReferences.length === 0)
      throw new BadRequestException(
        "A character must reference at least one published asset before it can be published",
      );
    const resolved = await this.assets.resolveReferences(context, draftReferences);
    const pinned = dedupeReferences(
      resolved.map((reference) => ({ assetId: reference.assetId, version: reference.version })),
    );
    const checksumSha256 = characterSnapshotChecksum(profile, pinned);
    const latest = await this.db.characterVersion.findFirst({
      where: { workspaceId: context.workspaceId, characterId },
      orderBy: { version: "desc" },
    });
    const version = (latest?.version ?? 0) + 1;
    try {
      const published = await this.db.$transaction(async (tx) => {
        const created = await tx.characterVersion.create({
          data: {
            workspaceId: context.workspaceId,
            characterId,
            version,
            status: "PUBLISHED",
            profile: profile as never,
            referenceAssets: pinned as never,
            checksumSha256,
            createdByUserId: context.userId,
            publishedAt: new Date(),
          },
        });
        await tx.character.update({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: characterId } },
          data: { status: "PUBLISHED", activeVersionId: created.id },
        });
        for (const reference of resolved) {
          await tx.assetUsageReference.create({
            data: {
              workspaceId: context.workspaceId,
              assetId: reference.assetId,
              assetVersion: reference.version,
              usedByType: "CHARACTER_VERSION",
              usedById: created.id,
              context: { characterId } as never,
            },
          });
        }
        return created;
      });
      return this.toVersionRecord(published);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          "Another publish completed for this character; retry to create the next version",
        );
      throw error;
    }
  }

  public async archive(context: WorkspaceContext, characterId: string): Promise<unknown> {
    this.assertCanMutate(context);
    const character = await this.get(context, characterId);
    if (character.status === "ARCHIVED") return character;
    await this.db.character.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: characterId } },
      data: { status: "ARCHIVED" },
    });
    return this.get(context, characterId);
  }

  public async listVersions(
    context: WorkspaceContext,
    characterId: string,
  ): Promise<CharacterVersionRecord[]> {
    await this.get(context, characterId);
    const versions = await this.db.characterVersion.findMany({
      where: { workspaceId: context.workspaceId, characterId },
      orderBy: { version: "asc" },
    });
    return versions.map((version) => this.toVersionRecord(version));
  }

  public async getVersion(
    context: WorkspaceContext,
    characterId: string,
    version: number,
  ): Promise<CharacterVersionRecord> {
    await this.get(context, characterId);
    if (!Number.isInteger(version) || version < 1)
      throw new BadRequestException("version must be a positive integer");
    const row = await this.db.characterVersion.findFirst({
      where: { workspaceId: context.workspaceId, characterId, version },
    });
    if (!row) throw new NotFoundException("Character version not found");
    return this.toVersionRecord(row);
  }

  public async referencePackage(
    context: WorkspaceContext,
    characterId: string,
    version?: number,
  ): Promise<CharacterReferencePackage> {
    const character = await this.get(context, characterId);
    if (version !== undefined && (!Number.isInteger(version) || version < 1))
      throw new BadRequestException("version must be a positive integer");
    const row =
      version === undefined
        ? character.activeVersionId === null
          ? null
          : await this.db.characterVersion.findFirst({
              where: {
                workspaceId: context.workspaceId,
                characterId,
                id: character.activeVersionId,
                status: "PUBLISHED",
              },
            })
        : await this.db.characterVersion.findFirst({
            where: { workspaceId: context.workspaceId, characterId, version, status: "PUBLISHED" },
          });
    if (!row)
      throw new NotFoundException(
        "No published character version is available for this reference package",
      );
    return this.buildPackage(context, row);
  }

  public listGroups(context: WorkspaceContext): Promise<unknown> {
    return this.db.characterGroup.findMany({
      where: { workspaceId: context.workspaceId },
      include: {
        members: { include: { character: true, characterVersion: true } },
        assignments: true,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  public async getGroup(context: WorkspaceContext, groupId: string): Promise<unknown> {
    if (!isUuid(groupId)) throw new BadRequestException("groupId must be a UUID");
    const group = await this.db.characterGroup.findFirst({
      where: { workspaceId: context.workspaceId, id: groupId },
      include: {
        members: { include: { character: true, characterVersion: true } },
        assignments: true,
      },
    });
    if (!group) throw new NotFoundException("Character group not found");
    return group;
  }

  public async createGroup(context: WorkspaceContext, body: unknown): Promise<unknown> {
    this.assertCanMutate(context);
    const input = validateGroupInput(body);
    return this.db.characterGroup.create({
      data: { workspaceId: context.workspaceId, ...input },
    });
  }

  public async updateGroup(
    context: WorkspaceContext,
    groupId: string,
    body: unknown,
  ): Promise<unknown> {
    this.assertCanMutate(context);
    await this.getGroup(context, groupId);
    const patch: CharacterGroupPatch = validateGroupPatch(body);
    await this.db.characterGroup.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: groupId } },
      data: patch as never,
    });
    return this.getGroup(context, groupId);
  }

  public async addMember(
    context: WorkspaceContext,
    groupId: string,
    body: unknown,
  ): Promise<unknown> {
    this.assertCanMutate(context);
    await this.getGroup(context, groupId);
    const input: CharacterGroupMemberInput = validateGroupMember(body);
    await this.get(context, input.characterId);
    const version = await this.db.characterVersion.findFirst({
      where: {
        workspaceId: context.workspaceId,
        characterId: input.characterId,
        id: input.characterVersionId,
        status: "PUBLISHED",
      },
    });
    if (!version)
      throw new NotFoundException(
        "Published character version not found for this character in the workspace",
      );
    try {
      return await this.db.characterGroupMember.create({
        data: {
          workspaceId: context.workspaceId,
          groupId,
          characterId: input.characterId,
          characterVersionId: input.characterVersionId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("Character is already a member of this group");
      throw error;
    }
  }

  public async removeMember(
    context: WorkspaceContext,
    groupId: string,
    characterId: string,
  ): Promise<void> {
    this.assertCanMutate(context);
    await this.getGroup(context, groupId);
    if (!isUuid(characterId)) throw new BadRequestException("characterId must be a UUID");
    const result = await this.db.characterGroupMember.deleteMany({
      where: { workspaceId: context.workspaceId, groupId, characterId },
    });
    if (result.count === 0) throw new NotFoundException("Character group member not found");
  }

  public async assign(context: WorkspaceContext, groupId: string, body: unknown): Promise<unknown> {
    this.assertCanMutate(context);
    await this.getGroup(context, groupId);
    const input: CharacterGroupAssignmentInput = validateGroupAssignment(body);
    if (input.channelId !== undefined) {
      const channel = await this.db.channel.findFirst({
        where: { workspaceId: context.workspaceId, id: input.channelId },
      });
      if (!channel) throw new NotFoundException("Channel not found in workspace");
    }
    if (input.seriesId !== undefined) {
      const series = await this.db.contentSeries.findFirst({
        where: { workspaceId: context.workspaceId, id: input.seriesId },
      });
      if (!series) throw new NotFoundException("Series not found in workspace");
    }
    try {
      return await this.db.characterGroupAssignment.create({
        data: { workspaceId: context.workspaceId, groupId, ...input },
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("Group is already assigned to that channel or series");
      throw error;
    }
  }

  public async removeAssignment(
    context: WorkspaceContext,
    groupId: string,
    assignmentId: string,
  ): Promise<void> {
    this.assertCanMutate(context);
    await this.getGroup(context, groupId);
    if (!isUuid(assignmentId)) throw new BadRequestException("assignmentId must be a UUID");
    const result = await this.db.characterGroupAssignment.deleteMany({
      where: { workspaceId: context.workspaceId, groupId, id: assignmentId },
    });
    if (result.count === 0) throw new NotFoundException("Character group assignment not found");
  }

  public async groupReferencePackage(
    context: WorkspaceContext,
    groupId: string,
  ): Promise<CharacterGroupReferencePackage> {
    const group = (await this.getGroup(context, groupId)) as {
      id: string;
      name: string;
      members: Array<{ characterId: string; characterVersionId: string }>;
      assignments: Array<{ channelId: string | null; seriesId: string | null }>;
    };
    const members: CharacterReferencePackage[] = [];
    for (const member of group.members) {
      const version = await this.db.characterVersion.findFirst({
        where: {
          workspaceId: context.workspaceId,
          characterId: member.characterId,
          id: member.characterVersionId,
          status: "PUBLISHED",
        },
      });
      if (!version)
        throw new ConflictException(
          "A pinned group member version is no longer available; remove or repin the member",
        );
      members.push(await this.buildPackage(context, version));
    }
    return {
      groupId: group.id,
      groupName: group.name,
      members,
      assignments: group.assignments.map((assignment) => ({
        channelId: assignment.channelId,
        seriesId: assignment.seriesId,
      })),
    };
  }

  private mergeProfile(
    input: CharacterCreateInput,
    template: {
      name: string;
      description: string;
      personality: unknown;
      voicePreference: unknown;
      visualInvariants: unknown;
      variationRules: unknown;
    } | null,
  ): CharacterProfile {
    if (template === null) {
      return {
        name: input.name as string,
        description: input.description ?? null,
        personality: input.personality as JsonValue,
        voicePreference: input.voicePreference as JsonValue,
        visualInvariants: input.visualInvariants as JsonValue,
        variationRules: input.variationRules as JsonValue,
      };
    }
    return {
      name: input.name ?? template.name,
      description: input.description ?? template.description,
      personality: input.personality ?? jsonValue(template.personality),
      voicePreference: input.voicePreference ?? jsonValue(template.voicePreference),
      visualInvariants: input.visualInvariants ?? jsonValue(template.visualInvariants),
      variationRules: input.variationRules ?? jsonValue(template.variationRules),
    };
  }

  private async attachStarterAsset(
    context: WorkspaceContext,
    starterAssetKey: string | null,
    references: readonly AssetReferenceRequest[],
  ): Promise<readonly AssetReferenceRequest[]> {
    if (starterAssetKey === null) return references;
    const definition = starterAssetDefinition(starterAssetKey);
    if (!definition)
      throw new InternalServerErrorException(
        `Starter character template references unknown asset key "${starterAssetKey}"`,
      );
    const asset = await this.assets.importStarterAsset(context, {
      key: definition.key,
      body: starterAssetBody(definition),
      declaredMediaType: definition.mediaType,
      filename: definition.filename,
      rightsHolder: definition.rightsHolder,
      licenseType: definition.licenseType,
      licenseTerms: definition.licenseTerms,
    });
    return dedupeReferences([{ assetId: asset.id, version: asset.version }, ...references]);
  }

  private toVersionRecord(row: CharacterVersionRow): CharacterVersionRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      characterId: row.characterId,
      version: row.version,
      status: row.status,
      profile: profileFromJson(row.profile),
      referenceAssets: persistedReferenceAssets(row.referenceAssets),
      checksumSha256: row.checksumSha256,
      createdByUserId: row.createdByUserId,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
    };
  }

  private async buildPackage(
    context: WorkspaceContext,
    row: CharacterVersionRow,
  ): Promise<CharacterReferencePackage> {
    const references = persistedReferenceAssets(row.referenceAssets);
    const assets: AssetReference[] = await this.assets.resolveReferences(context, references);
    return {
      characterId: row.characterId,
      characterVersionId: row.id,
      version: row.version,
      checksumSha256: row.checksumSha256,
      profile: profileFromJson(row.profile),
      assets,
      publishedAt: row.publishedAt,
    };
  }
}
