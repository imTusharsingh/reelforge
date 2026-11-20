import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createDatabaseClient } from "@reelforge/database";
import { AssetModule } from "./asset.module.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { sha256Hex } from "./storage/checksum.js";
import { StorageObjectNotFoundError, STORAGE_PORT } from "./storage/storage.port.js";
import type { StoragePort, StoragePutInput, StoragePutResult } from "./storage/storage.port.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const ownerId = randomUUID();
const viewerId = randomUUID();
const outsiderId = randomUUID();
const foreignOwnerId = randomUUID();

const assetRootId = randomUUID();
const assetV2Id = randomUUID();
const foreignAssetId = randomUUID();
const corruptAssetId = randomUUID();
const missingAssetId = randomUUID();

const assetV1Body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const assetV2Body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
const foreignAssetBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03]);
const corruptAssetBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04]);
const assetV1Key = `assets/${assetRootId}/v1/one.png`;
const assetV2Key = `assets/${assetRootId}/v2/two.png`;
const foreignAssetKey = `assets/${foreignAssetId}/v1/foreign.png`;
const corruptAssetKey = `assets/${corruptAssetId}/v1/corrupt.png`;
const missingAssetKey = `assets/${missingAssetId}/v1/missing.png`;
class MemoryStorage implements StoragePort {
  public readonly objects = new Map<string, Buffer>();

  public async putObject(input: StoragePutInput): Promise<StoragePutResult> {
    this.objects.set(`${input.workspaceId}/${input.objectKey}`, Buffer.from(input.body));
    return {
      objectKey: input.objectKey,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async getObject(input: { workspaceId: string; objectKey: string }): Promise<Buffer> {
    const body = this.objects.get(`${input.workspaceId}/${input.objectKey}`);
    if (!body) throw new StorageObjectNotFoundError();
    return body;
  }

  public async deleteObject(input: { workspaceId: string; objectKey: string }): Promise<void> {
    this.objects.delete(`${input.workspaceId}/${input.objectKey}`);
  }
}

function get(
  server: unknown,
  url: string,
  token?: string,
  headers: Readonly<Record<string, string>> = {},
): request.Test {
  let call = request(server as never)
    .get(url)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  if (token !== undefined) call = call.set("Authorization", `Bearer ${token}`);
  for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
  return call;
}

suite("authorized media delivery HTTP contract", () => {
  const db = databaseUrl ? createDatabaseClient(databaseUrl) : undefined;
  const storage = new MemoryStorage();
  let app: INestApplication | undefined;
  let ownerToken = "";
  let viewerToken = "";
  let outsiderToken = "";
  let foreignOwnerToken = "";

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [ownerId, viewerId, outsiderId, foreignOwnerId].map((id) => ({
        id,
        email: `${id}@m59-http.invalid`,
      })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m59-http" },
        { id: foreignWorkspaceId, name: "m59-foreign" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
        { workspaceId: foreignWorkspaceId, userId: foreignOwnerId, role: "OWNER" },
      ],
    });
    const sessions: string[] = [];
    for (const id of [ownerId, viewerId, outsiderId, foreignOwnerId]) {
      const token = randomUUID();
      sessions.push(token);
      await db.session.create({
        data: {
          userId: id,
          tokenHash: hashSessionToken(token),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    }
    [ownerToken, viewerToken, outsiderToken, foreignOwnerToken] = sessions as [
      string,
      string,
      string,
      string,
    ];

    const assetData = (input: {
      id: string;
      rootAssetId?: string;
      version?: number;
      objectKey: string;
      body: Buffer;
      filename: string;
      workspace?: string;
    }): Parameters<typeof db.asset.create>[0]["data"] => ({
      id: input.id,
      workspaceId: input.workspace ?? workspaceId,
      objectKey: input.objectKey,
      mediaType: "image/png",
      filename: input.filename,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
      version: input.version ?? 1,
      rootAssetId: input.rootAssetId ?? input.id,
      ownership: "USER_UPLOADED",
      status: "PUBLISHED",
      licenseType: "CC0-1.0",
      rightsHolder: "fixture",
      createdByUserId: ownerId,
    });
    await db.asset.create({
      data: assetData({
        id: assetRootId,
        objectKey: assetV1Key,
        body: assetV1Body,
        filename: "one.png",
      }),
    });
    await db.asset.create({
      data: assetData({
        id: assetV2Id,
        rootAssetId: assetRootId,
        version: 2,
        objectKey: assetV2Key,
        body: assetV2Body,
        filename: "two.png",
      }),
    });
    await db.asset.create({
      data: assetData({
        id: foreignAssetId,
        objectKey: foreignAssetKey,
        body: foreignAssetBody,
        filename: "foreign.png",
        workspace: foreignWorkspaceId,
      }),
    });
    await db.asset.create({
      data: assetData({
        id: corruptAssetId,
        objectKey: corruptAssetKey,
        body: corruptAssetBody,
        filename: "corrupt.png",
      }),
    });
    await db.asset.create({
      data: assetData({
        id: missingAssetId,
        objectKey: missingAssetKey,
        body: assetV1Body,
        filename: "missing.png",
      }),
    });

    storage.objects.set(`${workspaceId}/${assetV1Key}`, assetV1Body);
    storage.objects.set(`${workspaceId}/${assetV2Key}`, assetV2Body);
    storage.objects.set(`${foreignWorkspaceId}/${foreignAssetKey}`, foreignAssetBody);
    storage.objects.set(
      `${workspaceId}/${corruptAssetKey}`,
      Buffer.from("not the persisted bytes"),
    );
    // missingAssetKey intentionally has no stored object.
    const module = await Test.createTestingModule({ imports: [AssetModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(STORAGE_PORT)
      .useValue(storage)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.assetUsageReference.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.asset.deleteMany({
        where: { workspaceId: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.workspace.deleteMany({
        where: { id: { in: [workspaceId, foreignWorkspaceId] } },
      });
      await db.user.deleteMany({
        where: { id: { in: [ownerId, viewerId, outsiderId, foreignOwnerId] } },
      });
      await db.$disconnect();
    }
  });

  it("requires a session and current workspace membership", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const assetUrl = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content-v2`;
    expect((await get(server, assetUrl)).status).toBe(401);
    expect((await get(server, assetUrl, outsiderToken)).status).toBe(403);
    expect((await get(server, assetUrl, foreignOwnerToken)).status).toBe(403);
    expect((await get(server, assetUrl, viewerToken)).status).toBe(200);
  });

  it("authorizes the retired route before sending retirement headers", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const url = (workspace: string, asset: string, version = 1): string =>
      `/workspaces/${workspace}/assets/${asset}/versions/${version}/content`;

    await get(server, url(workspaceId, assetRootId)).expect(401);
    const denied = await get(server, url(workspaceId, assetRootId), foreignOwnerToken).expect(403);
    const deniedMissing = await get(
      server,
      url(workspaceId, randomUUID()),
      foreignOwnerToken,
    ).expect(403);
    expect(denied.body).toEqual(deniedMissing.body);

    const foreign = await get(server, url(workspaceId, foreignAssetId), ownerToken).expect(404);
    const missing = await get(server, url(workspaceId, randomUUID()), ownerToken).expect(404);
    expect(foreign.body).toEqual(missing.body);
    await get(server, url(workspaceId, assetRootId, 9), ownerToken).expect(404);
    expect(denied.headers["clear-site-data"]).toBeUndefined();
    expect(foreign.headers["clear-site-data"]).toBeUndefined();
  });

  it("checks current membership even with a previously issued ETag", async () => {
    if (!app || !db) return;
    const server = app.getHttpServer();
    const url = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content-v2`;
    const legacy = url.replace(/-v2$/, "");
    const retired = await get(server, legacy, viewerToken);
    expect(retired.status).toBe(410);
    expect(retired.headers["clear-site-data"]).toBe('"cache"');
    expect(retired.headers["cache-control"]).toBe("private, no-store");
    expect(retired.body).toHaveLength(0);
    const original = await get(server, url, viewerToken);
    expect(original.status).toBe(200);
    expect(original.headers["cache-control"]).toBe("private, no-store");
    const etag = original.headers.etag;
    if (typeof etag !== "string") throw new Error("Expected an ETag");
    const where = { workspaceId, userId: viewerId };
    await db.workspaceMembership.deleteMany({ where });
    try {
      expect(
        (
          await get(server, url, viewerToken, {
            "If-None-Match": etag,
            Range: "bytes=0-1",
          })
        ).status,
      ).toBe(403);
    } finally {
      await db.workspaceMembership.create({ data: { ...where, role: "VIEWER" } });
    }
  });

  it("delivers immutable versions with safe media headers", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const v1 = await get(
      server,
      `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content-v2`,
      viewerToken,
    );
    expect(v1.status).toBe(200);
    expect(v1.body).toEqual(assetV1Body);
    expect(v1.headers["content-type"]).toBe("image/png");
    expect(v1.headers["content-disposition"]).toContain("inline");
    expect(v1.headers["cache-control"]).toBe("private, no-store");
    expect(v1.headers["accept-ranges"]).toBe("bytes");
    expect(v1.headers["x-content-type-options"]).toBe("nosniff");
    expect(v1.headers.etag).toBe(`"sha256-${sha256Hex(assetV1Body)}"`);
    expect(v1.headers["content-length"]).toBe(String(assetV1Body.byteLength));

    const v2 = await get(
      server,
      `/workspaces/${workspaceId}/assets/${assetRootId}/versions/2/content-v2`,
      viewerToken,
    );
    expect(v2.status).toBe(200);
    expect(v2.body).toEqual(assetV2Body);

    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${assetRootId}/versions/9/content-v2`,
          viewerToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${assetRootId}/versions/not-a-number/content-v2`,
          viewerToken,
        )
      ).status,
    ).toBe(400);
  });

  it("denies cross-tenant asset IDs as not found", async () => {
    if (!app) return;
    const response = await get(
      app.getHttpServer(),
      `/workspaces/${workspaceId}/assets/${foreignAssetId}/versions/1/content-v2`,
      ownerToken,
    );
    expect(response.status).toBe(404);
  });

  it("supports single ranges and rejects unsatisfiable or multiple ranges", async () => {
    if (!app) return;
    const url = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content-v2`;
    const server = app.getHttpServer();
    const partial = await get(server, url, viewerToken, { Range: "bytes=0-3" });
    expect(partial.status).toBe(206);
    expect(partial.body).toEqual(assetV1Body.subarray(0, 4));
    expect(partial.headers["content-range"]).toBe(`bytes 0-3/${assetV1Body.byteLength}`);
    expect(partial.headers["content-length"]).toBe("4");

    const suffix = await get(server, url, viewerToken, { Range: "bytes=-4" });
    expect(suffix.status).toBe(206);
    expect(suffix.body).toEqual(assetV1Body.subarray(assetV1Body.byteLength - 4));
    expect(suffix.headers["content-range"]).toBe(
      `bytes ${assetV1Body.byteLength - 4}-${assetV1Body.byteLength - 1}/${assetV1Body.byteLength}`,
    );

    const unsatisfiable = await get(server, url, viewerToken, { Range: "bytes=999-" });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe(`bytes */${assetV1Body.byteLength}`);

    const multiple = await get(server, url, viewerToken, { Range: "bytes=0-1,3-4" });
    expect(multiple.status).toBe(416);

    const staleIfRange = await get(server, url, viewerToken, {
      Range: "bytes=0-1",
      "If-Range": '"sha256-other"',
    });
    expect(staleIfRange.status).toBe(200);
    expect(staleIfRange.body).toEqual(assetV1Body);
  });

  it("forces attachment downloads and supports HEAD metadata", async () => {
    if (!app) return;
    const url = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content-v2`;
    const download = await get(app.getHttpServer(), `${url}?download=true`, viewerToken);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-disposition"]).toContain("one.png");

    const head = await request(app.getHttpServer())
      .head(url)
      .set("Authorization", `Bearer ${viewerToken}`);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(assetV1Body.byteLength));
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.text).toBeUndefined();
  });

  it("rejects unknown download values before reading or resolving bytes", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    const assetUrl = `/workspaces/${workspaceId}/assets/${assetRootId}/versions/1/content-v2?download=1`;
    expect((await get(server, assetUrl, viewerToken)).status).toBe(400);
    const missingAssetUrl = `/workspaces/${workspaceId}/assets/${missingAssetId}/versions/1/content-v2?download=1`;
    expect((await get(server, missingAssetUrl, viewerToken)).status).toBe(400);
  });

  it("reports missing asset bytes as not found and corrupt bytes as a conflict", async () => {
    if (!app) return;
    const server = app.getHttpServer();
    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${missingAssetId}/versions/1/content-v2`,
          viewerToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await get(
          server,
          `/workspaces/${workspaceId}/assets/${corruptAssetId}/versions/1/content-v2`,
          viewerToken,
        )
      ).status,
    ).toBe(409);
  });
});
