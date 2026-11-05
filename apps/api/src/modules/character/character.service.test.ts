import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { AssetRecord, AssetReference, AssetReferenceRequest } from "../asset/asset.types.js";
import type { AssetService } from "../asset/asset.service.js";
import { CharacterService } from "./character.service.js";
import { characterSnapshotChecksum } from "./character.validation.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const starterAssetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const channelId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const seriesId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function context(role: WorkspaceContext["role"] = "OWNER"): WorkspaceContext {
  return { workspaceId, userId: "33333333-3333-4333-8333-333333333333", role };
}

class FakeAssets {
  public importCalls = 0;
  public resolveCalls = 0;

  public async importStarterAsset(): Promise<AssetRecord> {
    this.importCalls += 1;
    return { id: starterAssetId, version: 1 } as AssetRecord;
  }

  public async resolveReferences(
    _context: WorkspaceContext,
    references: readonly AssetReferenceRequest[],
  ): Promise<AssetReference[]> {
    this.resolveCalls += 1;
    return references.map((reference) => ({
      assetId: reference.assetId,
      version: reference.version ?? 1,
      checksumSha256: "a".repeat(64),
      objectKey: "assets/root/v1/file.png",
      mediaType: "image/png",
      byteSize: 8,
      ownership: "USER_UPLOADED",
      licenseType: "CC-BY-4.0",
      licenseTerms: null,
      rightsHolder: "Test",
    }));
  }
}

type Row = Record<string, unknown>;

class FakeCharacterDb {
  public readonly templates: Row[] = [];
  public readonly characters = new Map<string, Row>();
  public readonly versions: Row[] = [];
  public readonly groups = new Map<string, Row>();
  public readonly members: Row[] = [];
  public readonly assignments: Row[] = [];
  public readonly usage: Row[] = [];
  public readonly channels = new Set<string>();
  public readonly series = new Set<string>();

  public readonly characterTemplate = {
    findUnique: async (args: { where: { key: string } }): Promise<Row | null> =>
      this.templates.find((template) => template.key === args.where.key) ?? null,
  };

  public readonly character = {
    create: async (args: { data: Row }): Promise<Row> => {
      const now = new Date();
      const row: Row = {
        id: randomUUID(),
        status: "DRAFT",
        activeVersionId: null,
        description: null,
        ...args.data,
        createdAt: now,
        updatedAt: now,
      };
      this.characters.set(row.id as string, row);
      return row;
    },
    findFirst: async (args: {
      where: { workspaceId: string; id: string };
    }): Promise<Row | null> => {
      const row = this.characters.get(args.where.id);
      return row && row.workspaceId === args.where.workspaceId ? row : null;
    },
    update: async (args: {
      where: { workspaceId_id: { id: string } };
      data: Row;
    }): Promise<Row> => {
      const row = this.characters.get(args.where.workspaceId_id.id);
      if (!row) throw new Error("missing character");
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    },
  };

  public readonly characterVersion = {
    findFirst: async (args: {
      where: {
        workspaceId: string;
        characterId: string;
        id?: string;
        version?: number;
        status?: string;
      };
      orderBy?: { version?: "asc" | "desc" };
    }): Promise<Row | null> => {
      const matches = this.versions.filter(
        (row) =>
          row.workspaceId === args.where.workspaceId &&
          row.characterId === args.where.characterId &&
          (args.where.id === undefined || row.id === args.where.id) &&
          (args.where.version === undefined || row.version === args.where.version) &&
          (args.where.status === undefined || row.status === args.where.status),
      );
      if (args.orderBy?.version === "desc")
        matches.sort((left, right) => (right.version as number) - (left.version as number));
      return matches[0] ?? null;
    },
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = {
        id: randomUUID(),
        createdAt: new Date(),
        publishedAt: null,
        createdByUserId: null,
        ...args.data,
      };
      this.versions.push(row);
      return row;
    },
    findMany: async (args: {
      where: { workspaceId: string; characterId: string };
    }): Promise<Row[]> =>
      this.versions
        .filter(
          (row) =>
            row.workspaceId === args.where.workspaceId &&
            row.characterId === args.where.characterId,
        )
        .sort((left, right) => (left.version as number) - (right.version as number)),
  };

  public readonly characterGroup = {
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = { id: randomUUID(), ...args.data, createdAt: new Date() };
      this.groups.set(row.id as string, row);
      return row;
    },
    findFirst: async (args: {
      where: { workspaceId: string; id: string };
    }): Promise<Row | null> => {
      const group = this.groups.get(args.where.id);
      if (!group || group.workspaceId !== args.where.workspaceId) return null;
      return {
        ...group,
        members: this.members.filter(
          (member) => member.workspaceId === workspaceId && member.groupId === group.id,
        ),
        assignments: this.assignments.filter(
          (assignment) => assignment.workspaceId === workspaceId && assignment.groupId === group.id,
        ),
      };
    },
    update: async (args: {
      where: { workspaceId_id: { id: string } };
      data: Row;
    }): Promise<Row> => {
      const group = this.groups.get(args.where.workspaceId_id.id);
      if (!group) throw new Error("missing group");
      Object.assign(group, args.data);
      return group;
    },
  };

  public readonly characterGroupMember = {
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = { id: randomUUID(), ...args.data, createdAt: new Date() };
      this.members.push(row);
      return row;
    },
    deleteMany: async (args: {
      where: { workspaceId: string; groupId: string; characterId: string };
    }): Promise<{ count: number }> => {
      const before = this.members.length;
      for (let index = this.members.length - 1; index >= 0; index -= 1) {
        const row = this.members[index];
        if (
          row !== undefined &&
          row.workspaceId === args.where.workspaceId &&
          row.groupId === args.where.groupId &&
          row.characterId === args.where.characterId
        )
          this.members.splice(index, 1);
      }
      return { count: before - this.members.length };
    },
  };

  public readonly characterGroupAssignment = {
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = {
        id: randomUUID(),
        channelId: null,
        seriesId: null,
        ...args.data,
        createdAt: new Date(),
      };
      this.assignments.push(row);
      return row;
    },
    deleteMany: async (args: {
      where: { workspaceId: string; groupId: string; id: string };
    }): Promise<{ count: number }> => {
      const before = this.assignments.length;
      for (let index = this.assignments.length - 1; index >= 0; index -= 1) {
        const row = this.assignments[index];
        if (
          row !== undefined &&
          row.workspaceId === args.where.workspaceId &&
          row.groupId === args.where.groupId &&
          row.id === args.where.id
        )
          this.assignments.splice(index, 1);
      }
      return { count: before - this.assignments.length };
    },
  };

  public readonly channel = {
    findFirst: async (args: { where: { workspaceId: string; id: string } }): Promise<Row | null> =>
      args.where.workspaceId === workspaceId && this.channels.has(args.where.id)
        ? { id: args.where.id, language: null }
        : null,
  };

  public readonly contentSeries = {
    findFirst: async (args: { where: { workspaceId: string; id: string } }): Promise<Row | null> =>
      args.where.workspaceId === workspaceId && this.series.has(args.where.id)
        ? { id: args.where.id }
        : null,
  };

  public readonly assetUsageReference = {
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = { id: randomUUID(), ...args.data, createdAt: new Date() };
      this.usage.push(row);
      return row;
    },
  };

  public readonly $transaction = async <T>(
    callback: (tx: FakeCharacterDb) => Promise<T>,
  ): Promise<T> => callback(this);
}

function service(db: FakeCharacterDb, assets: FakeAssets): CharacterService {
  return new CharacterService(db as unknown as Database, assets as unknown as AssetService);
}

function seedCharacter(db: FakeCharacterDb, overrides: Row = {}): Row {
  const id = (overrides.id as string | undefined) ?? randomUUID();
  const row: Row = {
    id,
    workspaceId,
    name: "Nova",
    description: "A starter character",
    personality: { traits: ["curious"] },
    voicePreference: { style: "warm" },
    visualInvariants: { palette: ["#fff"] },
    variationRules: { allowed: ["pose"] },
    referenceAssets: [{ assetId: starterAssetId, version: 1 }],
    status: "DRAFT",
    activeVersionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  db.characters.set(id, row);
  return row;
}

describe("CharacterService", () => {
  it("creates a starter character and pins the imported starter asset", async () => {
    const db = new FakeCharacterDb();
    const assets = new FakeAssets();
    db.templates.push({
      id: randomUUID(),
      key: "starter-nova",
      name: "Nova",
      description: "A starter character",
      personality: { traits: ["curious"] },
      voicePreference: { style: "warm" },
      visualInvariants: { palette: ["#fff"] },
      variationRules: { allowed: ["pose"] },
      starterAssetKey: "starter-nova",
    });
    const created = (await service(db, assets).create(context(), {
      templateKey: "starter-nova",
    })) as Row;
    expect(created.name).toBe("Nova");
    expect(created.status).toBe("DRAFT");
    expect(created.referenceAssets).toEqual([{ assetId: starterAssetId, version: 1 }]);
    expect(assets.importCalls).toBe(1);
  });

  it("publishes immutable versions and increments the version number", async () => {
    const db = new FakeCharacterDb();
    const assets = new FakeAssets();
    const character = seedCharacter(db);
    const characters = service(db, assets);

    const first = (await characters.publish(context(), character.id as string)) as Row;
    expect(first.version).toBe(1);
    expect(first.status).toBe("PUBLISHED");
    expect(first.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(character.activeVersionId).toBe(first.id);
    expect(db.usage).toHaveLength(1);
    expect(db.usage[0]?.usedByType).toBe("CHARACTER_VERSION");
    expect(db.usage[0]?.usedById).toBe(first.id);

    await characters.update(context(), character.id as string, { name: "Nova Prime" });
    const second = (await characters.publish(context(), character.id as string)) as Row;
    expect(second.version).toBe(2);
    expect(second.checksumSha256).not.toBe(first.checksumSha256);
    expect((db.versions[0]?.profile as Row).name).toBe("Nova");
    expect((db.versions[1]?.profile as Row).name).toBe("Nova Prime");
  });

  it("refuses to publish a character without reference assets", async () => {
    const db = new FakeCharacterDb();
    const character = seedCharacter(db, { referenceAssets: [] });
    await expect(
      service(db, new FakeAssets()).publish(context(), character.id as string),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("denies cross-workspace character reads and publishes", async () => {
    const db = new FakeCharacterDb();
    const foreignCharacter = seedCharacter(db, { workspaceId: otherWorkspaceId });
    const characters = service(db, new FakeAssets());

    await expect(characters.get(context(), foreignCharacter.id as string)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      characters.publish(context(), foreignCharacter.id as string),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the immutable reference package for the active version", async () => {
    const db = new FakeCharacterDb();
    const assets = new FakeAssets();
    const character = seedCharacter(db);
    const characters = service(db, assets);
    const published = (await characters.publish(context(), character.id as string)) as Row;
    const reference = await characters.referencePackage(context(), character.id as string);
    expect(reference.characterVersionId).toBe(published.id);
    expect(reference.checksumSha256).toBe(published.checksumSha256);
    expect(reference.assets[0]?.assetId).toBe(starterAssetId);
  });

  it("requires exactly one assignment target and verifies workspace scope", async () => {
    const db = new FakeCharacterDb();
    const characters = service(db, new FakeAssets());
    const group = (await characters.createGroup(context(), { name: "Duo" })) as Row;
    const groupId = group.id as string;
    await expect(
      characters.assign(context(), groupId, { channelId, seriesId }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(characters.assign(context(), groupId, { channelId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    db.channels.add(channelId);
    const assignment = (await characters.assign(context(), groupId, { channelId })) as Row;
    expect(assignment.channelId).toBe(channelId);
    expect(assignment.seriesId).toBeNull();
  });

  it("denies cross-workspace group reads and mutations", async () => {
    const db = new FakeCharacterDb();
    const foreignGroup = await db.characterGroup.create({
      data: { workspaceId: otherWorkspaceId, name: "Foreign group" },
    });
    const characters = service(db, new FakeAssets());
    const foreignGroupId = foreignGroup.id as string;

    await expect(characters.getGroup(context(), foreignGroupId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      characters.updateGroup(context(), foreignGroupId, { name: "Tampered" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      characters.assign(context(), foreignGroupId, { channelId }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.groups.get(foreignGroupId)?.name).toBe("Foreign group");
  });

  it("rejects a pinned version that belongs to another character", async () => {
    const db = new FakeCharacterDb();
    const characters = service(db, new FakeAssets());
    const group = (await characters.createGroup(context(), { name: "Duo" })) as Row;
    const character = seedCharacter(db);
    db.versions.push({
      id: randomUUID(),
      workspaceId,
      characterId: randomUUID(),
      version: 1,
      status: "PUBLISHED",
      profile: {},
      referenceAssets: [],
      checksumSha256: "a".repeat(64),
      publishedAt: new Date(),
      createdAt: new Date(),
    });
    await expect(
      characters.addMember(context(), group.id as string, {
        characterId: character.id,
        characterVersionId: db.versions[0]?.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("builds a group package from pinned member versions and assignments", async () => {
    const db = new FakeCharacterDb();
    const assets = new FakeAssets();
    const characters = service(db, assets);
    const character = seedCharacter(db);
    const published = (await characters.publish(context(), character.id as string)) as Row;
    const group = (await characters.createGroup(context(), { name: "Duo" })) as Row;
    await characters.addMember(context(), group.id as string, {
      characterId: character.id,
      characterVersionId: published.id,
    });
    db.channels.add(channelId);
    await characters.assign(context(), group.id as string, { channelId });
    const reference = await characters.groupReferencePackage(context(), group.id as string);
    expect(reference.members).toHaveLength(1);
    expect(reference.members[0]?.characterVersionId).toBe(published.id);
    expect(reference.assignments).toEqual([{ channelId, seriesId: null }]);
  });

  it("keeps the snapshot checksum stable for equivalent profile ordering", () => {
    const left = characterSnapshotChecksum(
      {
        name: "Nova",
        description: null,
        personality: { traits: ["curious"], energy: "warm" },
        voicePreference: { style: "warm" },
        visualInvariants: {},
        variationRules: {},
      },
      [{ assetId: starterAssetId, version: 1 }],
    );
    const right = characterSnapshotChecksum(
      {
        name: "Nova",
        description: null,
        personality: { energy: "warm", traits: ["curious"] },
        voicePreference: { style: "warm" },
        visualInvariants: {},
        variationRules: {},
      },
      [{ assetId: starterAssetId, version: 1 }],
    );
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });
});
