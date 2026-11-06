import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import {
  IMAGE_PROVIDER,
  PROVIDER_REGISTRY,
  ProviderRegistry,
  TTS_PROVIDER,
  VIDEO_PROVIDER,
} from "@reelforge/ai-providers";
import request from "supertest";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { SceneMediaModule } from "./scene-media.module.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const ownerId = randomUUID();
const viewerId = randomUUID();
const outsiderId = randomUUID();
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();

async function session(
  db: ReturnType<typeof createDatabaseClient>,
  userId: string,
): Promise<string> {
  const token = randomUUID();
  await db.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) },
  });
  return token;
}

suite("SceneMediaController authentication and workspace guards", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let app: INestApplication | undefined;
  let ownerToken = "";
  let viewerToken = "";
  let outsiderToken = "";

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [ownerId, viewerId, outsiderId].map((id) => ({
        id,
        email: `${id}@scene-http.invalid`,
      })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "scene-http" },
        { id: foreignWorkspaceId, name: "scene-foreign" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
        { workspaceId: foreignWorkspaceId, userId: outsiderId, role: "OWNER" },
      ],
    });
    [ownerToken, viewerToken, outsiderToken] = await Promise.all([
      session(db, ownerId),
      session(db, viewerId),
      session(db, outsiderId),
    ]);
    const module = await Test.createTestingModule({ imports: [SceneMediaModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(IMAGE_PROVIDER)
      .useValue({
        capability: {},
        generate: async () => {
          throw new Error("not dispatched");
        },
      })
      .overrideProvider(VIDEO_PROVIDER)
      .useValue({
        capability: {},
        generate: async () => {
          throw new Error("not dispatched");
        },
      })
      .overrideProvider(TTS_PROVIDER)
      .useValue({
        capability: {},
        synthesize: async () => {
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

  it("returns 401, 403, and 404 for the scene media routes", async () => {
    const missing = randomUUID();
    const base = `/workspaces/${workspaceId}/scene-media`;
    await request(app!.getHttpServer() as never)
      .get(`${base}/jobs/${missing}`)
      .expect(401);
    await request(app!.getHttpServer() as never)
      .post(`${base}/jobs`)
      .expect(401);
    await request(app!.getHttpServer() as never)
      .get(`${base}/provider-health/provider/image`)
      .expect(401);
    await request(app!.getHttpServer() as never)
      .get(`${base}/jobs/${missing}`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .expect(403);
    await request(app!.getHttpServer() as never)
      .post(`${base}/jobs`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ scriptId: missing, idempotencyKey: "viewer", outputs: { image: true } })
      .expect(403);
    await request(app!.getHttpServer() as never)
      .get(`${base}/provider-health/provider/image`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .expect(403);
    await request(app!.getHttpServer() as never)
      .get(`${base}/jobs/${missing}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(404);
    await request(app!.getHttpServer() as never)
      .get(`${base}/jobs/${missing}`)
      .set("Authorization", `Bearer ${viewerToken}`)
      .expect(404);
  });
});
