import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { AssetRecord } from "./asset.types.js";
import { AssetService } from "./asset.service.js";
import { sha256Hex } from "./storage/checksum.js";
import { StorageObjectNotFoundError } from "./storage/storage.port.js";
import type { StoragePort, StoragePutInput, StoragePutResult } from "./storage/storage.port.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function context(role: WorkspaceContext["role"] = "OWNER"): WorkspaceContext {
  return { workspaceId, userId: "33333333-3333-4333-8333-333333333333", role };
}

class MemoryStorage implements StoragePort {
  public readonly objects = new Map<string, Buffer>();
  public fail = false;
  public failGet = false;

  public async putObject(input: StoragePutInput): Promise<StoragePutResult> {
    if (this.fail) throw new Error("simulated storage outage");
    this.objects.set(`${input.workspaceId}/${input.objectKey}`, Buffer.from(input.body));
    return {
      objectKey: input.objectKey,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async getObject(input: { workspaceId: string; objectKey: string }): Promise<Buffer> {
    if (this.failGet) throw new Error("simulated storage outage");
    const body = this.objects.get(`${input.workspaceId}/${input.objectKey}`);
    if (!body) throw new StorageObjectNotFoundError();
    return body;
  }

  public async deleteObject(input: { workspaceId: string; objectKey: string }): Promise<void> {
    this.objects.delete(`${input.workspaceId}/${input.objectKey}`);
  }
}

class FakeAssetDb {
  public readonly rows = new Map<string, AssetRecord>();
  public readonly usage: Array<Record<string, unknown>> = [];
  public createCalls = 0;

  public seed(partial: Partial<AssetRecord>): AssetRecord {
    const id = partial.id ?? randomUUID();
    const now = new Date();
    const row: AssetRecord = {
      id,
      workspaceId,
      objectKey: `assets/${id}/v1/file.png`,
      mediaType: "image/png",
      filename: "file.png",
      byteSize: png.byteLength,
      checksumSha256: sha256Hex(png),
      version: 1,
      rootAssetId: id,
      supersedesAssetId: null,
      ownership: "USER_UPLOADED",
      status: "PUBLISHED",
      licenseType: "CC-BY-4.0",
      licenseTerms: null,
      rightsHolder: "Test",
      rightsAttestedAt: now,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
      ...partial,
    };
    this.rows.set(row.id, row);
    return row;
  }

  public readonly asset = {
    create: async (args: { data: Record<string, unknown> }): Promise<AssetRecord> => {
      this.createCalls += 1;
      const now = new Date();
      const data = args.data;
      const row: AssetRecord = {
        id: data.id as string,
        workspaceId: data.workspaceId as string,
        objectKey: data.objectKey as string,
        mediaType: data.mediaType as string,
        filename: (data.filename as string | undefined) ?? null,
        byteSize: (data.byteSize as number | undefined) ?? null,
        checksumSha256: (data.checksumSha256 as string | undefined) ?? null,
        version: (data.version as number | undefined) ?? 1,
        rootAssetId: data.rootAssetId as string,
        supersedesAssetId: (data.supersedesAssetId as string | undefined) ?? null,
        ownership: (data.ownership as AssetRecord["ownership"] | undefined) ?? "USER_UPLOADED",
        status: (data.status as AssetRecord["status"] | undefined) ?? "PENDING",
        licenseType: (data.licenseType as string | undefined) ?? null,
        licenseTerms: (data.licenseTerms as string | undefined) ?? null,
        rightsHolder: (data.rightsHolder as string | undefined) ?? null,
        rightsAttestedAt: (data.rightsAttestedAt as Date | undefined) ?? null,
        createdByUserId: (data.createdByUserId as string | undefined) ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(row.id, row);
      return row;
    },
    update: async (args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: Partial<AssetRecord>;
    }): Promise<AssetRecord> => {
      const row = this.rows.get(args.where.workspaceId_id.id);
      if (!row) throw new Error("missing row");
      const updated = { ...row, ...args.data, updatedAt: new Date() } as AssetRecord;
      this.rows.set(updated.id, updated);
      return updated;
    },
    findFirst: async (args: {
      where: {
        workspaceId: string;
        id?: string;
        rootAssetId?: string;
        objectKey?: string;
        version?: number;
        OR?: Array<{ id?: string; rootAssetId?: string; version?: number }>;
      };
      orderBy?: { version?: "asc" | "desc" };
    }): Promise<AssetRecord | null> => {
      const matchesOr = (row: AssetRecord): boolean =>
        args.where.OR === undefined ||
        args.where.OR.some(
          (candidate) =>
            (candidate.id === undefined || row.id === candidate.id) &&
            (candidate.rootAssetId === undefined || row.rootAssetId === candidate.rootAssetId) &&
            (candidate.version === undefined || row.version === candidate.version),
        );
      const matches = [...this.rows.values()].filter(
        (row) =>
          row.workspaceId === args.where.workspaceId &&
          (args.where.id === undefined || row.id === args.where.id) &&
          (args.where.rootAssetId === undefined || row.rootAssetId === args.where.rootAssetId) &&
          (args.where.objectKey === undefined || row.objectKey === args.where.objectKey) &&
          (args.where.version === undefined || row.version === args.where.version) &&
          matchesOr(row),
      );
      if (args.orderBy?.version === "desc")
        matches.sort((left, right) => right.version - left.version);
      return matches[0] ?? null;
    },
    findMany: async (args: {
      where: { workspaceId: string; rootAssetId?: string };
      orderBy?: { version?: "asc" | "desc" };
    }): Promise<AssetRecord[]> => {
      const matches = [...this.rows.values()].filter(
        (row) =>
          row.workspaceId === args.where.workspaceId &&
          (args.where.rootAssetId === undefined || row.rootAssetId === args.where.rootAssetId),
      );
      return matches.sort((left, right) => left.version - right.version);
    },
  };

  public readonly assetUsageReference = {
    findMany: async (args: {
      where: { workspaceId: string; assetId: string };
    }): Promise<Array<Record<string, unknown>>> =>
      this.usage.filter(
        (row) => row.workspaceId === args.where.workspaceId && row.assetId === args.where.assetId,
      ),
  };
}

function service(db: FakeAssetDb, storage: MemoryStorage): AssetService {
  return new AssetService(db as unknown as Database, storage);
}

const validUpload = {
  body: png,
  declaredMediaType: "image/png",
  filename: "reference.png",
  rights: {
    ownership: "USER_UPLOADED" as const,
    rightsHolder: "Test owner",
    licenseType: "CC-BY-4.0",
    rightsAttested: true as const,
  },
};

describe("AssetService", () => {
  it("writes real bytes before marking an upload published", async () => {
    const db = new FakeAssetDb();
    const storage = new MemoryStorage();
    const asset = await service(db, storage).upload(context(), validUpload);
    expect(asset.status).toBe("PUBLISHED");
    expect(asset.checksumSha256).toBe(sha256Hex(png));
    expect(storage.objects.size).toBe(1);
  });

  it("marks the row failed and never reports success when storage fails", async () => {
    const db = new FakeAssetDb();
    const storage = new MemoryStorage();
    storage.fail = true;
    await expect(service(db, storage).upload(context(), validUpload)).rejects.toThrow(
      "Asset storage write failed",
    );
    expect([...db.rows.values()][0]?.status).toBe("FAILED");
  });

  it("denies viewer uploads before touching the database", async () => {
    const db = new FakeAssetDb();
    await expect(
      service(db, new MemoryStorage()).upload(context("VIEWER"), validUpload),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.createCalls).toBe(0);
  });

  it("does not return an asset from another workspace", async () => {
    const db = new FakeAssetDb();
    const row = db.seed({ workspaceId: otherWorkspaceId });
    await expect(service(db, new MemoryStorage()).get(context(), row.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuses to resolve an unpublished asset version", async () => {
    const db = new FakeAssetDb();
    const row = db.seed({ status: "PENDING" });
    await expect(
      service(db, new MemoryStorage()).getReference(context(), { assetId: row.id }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("returns checksum, size, and rights metadata for a published version", async () => {
    const db = new FakeAssetDb();
    const row = db.seed({});
    const reference = await service(db, new MemoryStorage()).getReference(context(), {
      assetId: row.id,
    });
    expect(reference).toMatchObject({
      assetId: row.id,
      version: 1,
      checksumSha256: sha256Hex(png),
      licenseType: "CC-BY-4.0",
      rightsHolder: "Test",
    });
  });

  it("resolves a version through its root asset ID and lists the chain", async () => {
    const db = new FakeAssetDb();
    const first = db.seed({});
    const second = db.seed({
      rootAssetId: first.id,
      version: 2,
      objectKey: "assets/root/v2/x.png",
    });
    const assets = service(db, new MemoryStorage());
    const reference = await assets.getReference(context(), {
      assetId: first.id,
      version: 2,
    });
    expect(reference.assetId).toBe(second.id);
    expect((await assets.listVersions(context(), second.id)).map((row) => row.version)).toEqual([
      1, 2,
    ]);
  });

  it("rejects user uploads that claim starter or system ownership", async () => {
    const db = new FakeAssetDb();
    await expect(
      service(db, new MemoryStorage()).upload(context(), {
        ...validUpload,
        rights: { ...validUpload.rights, ownership: "STARTER_LIBRARY" },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.createCalls).toBe(0);
  });

  it("delivers viewer read access to an exact immutable asset version", async () => {
    const db = new FakeAssetDb();
    const storage = new MemoryStorage();
    const row = db.seed({});
    storage.objects.set(`${workspaceId}/${row.objectKey}`, png);
    const content = await service(db, storage).getContent(context("VIEWER"), row.id, 1);
    expect(content).toMatchObject({
      mediaType: "image/png",
      byteSize: png.byteLength,
      checksumSha256: sha256Hex(png),
      filename: "file.png",
      cacheControl: "private, max-age=31536000, immutable",
    });
    expect(content.body).toEqual(png);
  });

  it("delivers each asset version by root ID without changing older bytes", async () => {
    const db = new FakeAssetDb();
    const storage = new MemoryStorage();
    const first = db.seed({});
    const secondBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const second = db.seed({
      rootAssetId: first.id,
      version: 2,
      objectKey: "assets/root/v2/second.png",
      byteSize: secondBytes.byteLength,
      checksumSha256: sha256Hex(secondBytes),
      filename: "second.png",
    });
    storage.objects.set(`${workspaceId}/${first.objectKey}`, png);
    storage.objects.set(`${workspaceId}/${second.objectKey}`, secondBytes);
    const assets = service(db, storage);
    expect((await assets.getContent(context(), first.id, 1)).body).toEqual(png);
    expect((await assets.getContent(context(), first.id, 2)).body).toEqual(secondBytes);
    expect((await assets.getContent(context(), second.id, 2)).body).toEqual(secondBytes);
  });

  it("denies cross-tenant asset content without revealing existence", async () => {
    const db = new FakeAssetDb();
    const storage = new MemoryStorage();
    const row = db.seed({ workspaceId: otherWorkspaceId });
    storage.objects.set(`${otherWorkspaceId}/${row.objectKey}`, png);
    await expect(service(db, storage).getContent(context(), row.id, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("rejects unpublished asset content", async () => {
    const db = new FakeAssetDb();
    const row = db.seed({ status: "PENDING" });
    await expect(
      service(db, new MemoryStorage()).getContent(context(), row.id, 1),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("reports missing asset bytes as not found and corrupt bytes as a conflict", async () => {
    const db = new FakeAssetDb();
    const missing = db.seed({});
    const assets = service(db, new MemoryStorage());
    await expect(assets.getContent(context(), missing.id, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const corruptDb = new FakeAssetDb();
    const corrupt = corruptDb.seed({});
    const storage = new MemoryStorage();
    storage.objects.set(`${workspaceId}/${corrupt.objectKey}`, Buffer.from("different bytes"));
    await expect(
      service(corruptDb, storage).getContent(context(), corrupt.id, 1),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("reports a storage outage as unavailable rather than missing", async () => {
    const db = new FakeAssetDb();
    const row = db.seed({});
    const storage = new MemoryStorage();
    storage.failGet = true;
    await expect(service(db, storage).getContent(context(), row.id, 1)).rejects.toThrow(
      /storage could not be read/,
    );
  });
});
