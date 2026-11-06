import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import { PROVIDER_REGISTRY, ProviderRegistry, SCRIPT_LLM } from "@reelforge/ai-providers";
import request from "supertest";
import { ScriptModule } from "./script.module.js";
import { hashSessionToken } from "../identity/auth.crypto.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const ownerId = randomUUID();
const viewerId = randomUUID();
const outsiderId = randomUUID();
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const ideaId = randomUUID();
const snapshotId = randomUUID();
const scriptId = randomUUID();

async function session(
  db: ReturnType<typeof createDatabaseClient>,
  userId: string,
): Promise<string> {
  const token = randomUUID();
  await db.session.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return token;
}

suite("ScriptController HTTP authentication and workspace guards", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let app: INestApplication | undefined;
  let ownerToken = "";
  let viewerToken = "";
  let outsiderToken = "";
  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [ownerId, viewerId, outsiderId].map((id) => ({ id, email: `${id}@http.invalid` })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "script-http" },
        { id: foreignWorkspaceId, name: "foreign-http" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
        { workspaceId: foreignWorkspaceId, userId: outsiderId, role: "OWNER" },
      ],
    });
    await db.idea.create({
      data: {
        id: ideaId,
        workspaceId,
        origin: "USER",
        status: "APPROVED",
        title: "HTTP idea",
        normalizedTitle: "http idea",
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        expectedFormat: "short",
        createdByUserId: ownerId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        ideaId,
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        expectedFormat: "short",
        checksumSha256: "checksum",
      },
    });
    await db.script.create({
      data: {
        id: scriptId,
        workspaceId,
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        createdByUserId: ownerId,
      },
    });
    [ownerToken, viewerToken, outsiderToken] = await Promise.all([
      session(db, ownerId),
      session(db, viewerId),
      session(db, outsiderId),
    ]);
    const module = await Test.createTestingModule({ imports: [ScriptModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(SCRIPT_LLM)
      .useValue({
        capability: {},
        complete: async () => {
          throw new Error("not dispatched");
        },
      })
      .overrideProvider(PROVIDER_REGISTRY)
      .useValue(new ProviderRegistry())
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await db.workspace.deleteMany({ where: { id: { in: [workspaceId, foreignWorkspaceId] } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, viewerId, outsiderId] } } });
    await db.$disconnect();
  });

  it("returns 401 for unauthenticated lifecycle and health routes", async () => {
    const base = `/workspaces/${workspaceId}/scripts`;
    const paths = [
      ["get", `${base}/${scriptId}`],
      ["post", `${base}/${scriptId}/revisions`],
      ["post", `${base}/${scriptId}/approve`],
      ["get", `${base}/${scriptId}/export`],
      ["get", `${base}/provider-health/provider/llm`],
    ] as const;
    for (const [method, path] of paths) {
      await request(app!.getHttpServer() as never)
        [method](path)
        .expect(401);
    }
  });

  it("rejects a valid session that is not a member of the requested workspace", async () => {
    const base = `/workspaces/${workspaceId}/scripts`;
    const paths = [
      ["get", `${base}/${scriptId}`],
      ["post", `${base}/${scriptId}/revisions`],
      ["post", `${base}/${scriptId}/approve`],
      ["get", `${base}/${scriptId}/export`],
      ["get", `${base}/provider-health/provider/llm`],
    ] as const;
    for (const [method, path] of paths) {
      await request(app!.getHttpServer() as never)
        [method](path)
        .set("Authorization", `Bearer ${outsiderToken}`)
        .expect(403);
    }
  });

  it("rejects viewer generate, revision, approval, and health mutations", async () => {
    const base = `/workspaces/${workspaceId}/scripts`;
    const paths = [
      ["post", base],
      ["post", `${base}/${scriptId}/revisions`],
      ["post", `${base}/${scriptId}/approve`],
      ["get", `${base}/provider-health/provider/llm`],
    ] as const;
    for (const [method, path] of paths) {
      await request(app!.getHttpServer() as never)
        [method](path)
        .set("Authorization", `Bearer ${viewerToken}`)
        .send({})
        .expect(403);
    }
  });

  it("allows an owner read through the actual authenticated route", async () => {
    await request(app!.getHttpServer() as never)
      .get(`/workspaces/${workspaceId}/scripts/${scriptId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
  });
});
