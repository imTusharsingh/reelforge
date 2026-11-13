import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import request from "supertest";
import { IdentityModule } from "./identity.module.js";
import { hashPassword, hashSessionToken } from "./auth.crypto.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("C5 authenticated account HTTP routes", () => {
  const db = databaseUrl ? createDatabaseClient(databaseUrl) : undefined;
  const userId = randomUUID();
  const token = randomUUID();
  let app: INestApplication;
  beforeAll(async () => {
    if (!db) return;
    await db.user.create({
      data: {
        id: userId,
        email: `${userId}@account-http.invalid`,
        credential: { create: { passwordHash: await hashPassword("current-password-123") } },
      },
    });
    await db.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const module = await Test.createTestingModule({ imports: [IdentityModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    if (!db) return;
    await db.authEvent.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });
  it("returns 401 without a session for each account route", async () => {
    await request(app.getHttpServer() as never)
      .get("/api/v1/auth/me")
      .expect(401);
    await request(app.getHttpServer() as never)
      .patch("/api/v1/auth/me")
      .send({ displayName: "Test" })
      .expect(401);
    await request(app.getHttpServer() as never)
      .post("/api/v1/auth/me/password")
      .send({ currentPassword: "current-password-123", newPassword: "new-password-12345" })
      .expect(401);
  });
  it("exposes only profile fields and rejects invalid or unknown body fields", async () => {
    const result = await request(app.getHttpServer() as never)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(Object.keys(result.body).sort()).toEqual(["displayName", "email", "userId"]);
    for (const body of [
      { displayName: "   " },
      { displayName: "Name", email: "changed@example.com" },
      { displayName: "bad\u0000name" },
    ]) {
      await request(app.getHttpServer() as never)
        .patch("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(400);
    }
    const saved = await request(app.getHttpServer() as never)
      .patch("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ displayName: "  Creator  " })
      .expect(200);
    expect(saved.body.displayName).toBe("Creator");
    await request(app.getHttpServer() as never)
      .post("/api/v1/auth/me/password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "wrong-password", newPassword: "new-password-12345" })
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe("INVALID_CREDENTIALS"));
  });
});
