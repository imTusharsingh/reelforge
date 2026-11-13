import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { HttpException } from "@nestjs/common";
import * as authCrypto from "./auth.crypto.js";
import { IdentityService } from "./identity.service.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

suite("C5 identity account (PostgreSQL)", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const userId = randomUUID();
  const email = `${userId}@c5.integration.invalid`;
  const currentPassword = "current-password-123";
  const newPassword = "brand-new-password-123";

  beforeAll(async () => {
    if (!db) return;
    await db.user.create({
      data: {
        id: userId,
        email,
        displayName: "Original",
        credential: { create: { passwordHash: await authCrypto.hashPassword(currentPassword) } },
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.authEvent.deleteMany({ where: { userId } });
    await db.session.deleteMany({ where: { userId } });
    await db.passwordCredential.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("me returns profile without secrets", async () => {
    if (!db) return;
    const service = new IdentityService(db as never);
    const me = await service.me(userId);
    expect(me).toEqual({ userId, email, displayName: "Original" });
    expect("passwordHash" in me).toBe(false);
    expect(JSON.stringify(me)).not.toContain("tokenHash");
  });

  it("updates and validates display name", async () => {
    if (!db) return;
    const service = new IdentityService(db as never);
    await expect(service.updateProfile(userId, "   ")).rejects.toThrow();
    await expect(service.updateProfile(userId, "bad\u0007name")).rejects.toThrow();
    const updated = await service.updateProfile(userId, "  New Name  ");
    expect(updated.displayName).toBe("New Name");
    const event = await db.authEvent.findFirst({
      where: { userId, eventType: "auth.profile_updated", outcome: "success" },
      orderBy: { occurredAt: "desc" },
    });
    expect(event).not.toBeNull();
  });

  it("rejects wrong current password, rate limits after failures, and changes password successfully", async () => {
    if (!db) return;
    const service = new IdentityService(db as never);
    await db.session.deleteMany({ where: { userId } });
    await db.authEvent.deleteMany({ where: { userId, eventType: "auth.password_changed" } });

    const currentSession = await db.session.create({
      data: {
        userId,
        tokenHash: `current-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const otherSession = await db.session.create({
      data: {
        userId,
        tokenHash: `other-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const principal = { userId, sessionId: currentSession.id };

    await expect(
      service.changePassword(principal, "wrong-password-123", newPassword),
    ).rejects.toMatchObject({ status: 401 });
    const failure = await db.authEvent.findFirst({
      where: { userId, eventType: "auth.password_changed", outcome: "failure" },
      orderBy: { occurredAt: "desc" },
    });
    expect(failure).not.toBeNull();

    // Seed 4 more recent failures to reach the 5-failure threshold before the next attempt.
    await db.authEvent.createMany({
      data: Array.from({ length: 4 }, () => ({
        userId,
        eventType: "auth.password_changed",
        outcome: "failure",
        occurredAt: new Date(),
      })),
    });

    const verifySpy = vi.spyOn(authCrypto, "verifyPassword");
    await expect(service.changePassword(principal, currentPassword, newPassword)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
    );
    expect(verifySpy).not.toHaveBeenCalled();
    const limited = await db.authEvent.findFirst({
      where: { userId, eventType: "auth.password_changed", outcome: "rate_limited" },
      orderBy: { occurredAt: "desc" },
    });
    expect(limited).not.toBeNull();
    verifySpy.mockRestore();

    // Clear failure window so a valid change can proceed.
    await db.authEvent.deleteMany({
      where: { userId, eventType: "auth.password_changed", outcome: "failure" },
    });

    const result = await service.changePassword(principal, currentPassword, newPassword);
    expect(result).toEqual({ ok: true, revokedSessions: 1 });

    const credential = await db.passwordCredential.findUnique({ where: { userId } });
    expect(credential).not.toBeNull();
    expect(await authCrypto.verifyPassword(newPassword, credential!.passwordHash)).toBe(true);
    expect(await authCrypto.verifyPassword(currentPassword, credential!.passwordHash)).toBe(false);

    const current = await db.session.findUnique({ where: { id: currentSession.id } });
    const other = await db.session.findUnique({ where: { id: otherSession.id } });
    expect(current?.revokedAt).toBeNull();
    expect(other?.revokedAt).not.toBeNull();

    const success = await db.authEvent.findFirst({
      where: { userId, eventType: "auth.password_changed", outcome: "success" },
      orderBy: { occurredAt: "desc" },
    });
    expect(success).not.toBeNull();
  });

  it("unauthenticated principal resolution gets 401", async () => {
    if (!db) return;
    const service = new IdentityService(db as never);
    await expect(service.principalForToken("not-a-real-token")).rejects.toMatchObject({
      status: 401,
    });
  });
});
