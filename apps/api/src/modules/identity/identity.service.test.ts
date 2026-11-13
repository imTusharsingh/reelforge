import { describe, expect, it, vi } from "vitest";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import type { Principal } from "./identity.types.js";
import * as authCrypto from "./auth.crypto.js";
import { IdentityService } from "./identity.service.js";

const principal: Principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
};

function createDb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tx = {
    passwordCredential: { upsert: vi.fn().mockResolvedValue({}) },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    authEvent: { create: vi.fn().mockResolvedValue({}) },
    ...(overrides.tx as Record<string, unknown> | undefined),
  };
  return {
    authEvent: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({}) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: principal.userId,
        email: "user@example.com",
        displayName: "User",
        credential: { passwordHash: "stored-hash" },
      }),
      update: vi.fn().mockResolvedValue({
        id: principal.userId,
        email: "user@example.com",
        displayName: "Updated",
      }),
    },
    passwordCredential: { upsert: vi.fn().mockResolvedValue({}) },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    $transaction: vi.fn(async (cb: (client: unknown) => Promise<unknown>) => cb(tx)),
    _tx: tx,
    ...overrides,
  };
}

describe("IdentityService C5 account", () => {
  it("me returns profile without secrets", async () => {
    const db = createDb();
    const service = new IdentityService(db as never);
    const result = await service.me(principal.userId);
    expect(result).toEqual({
      userId: principal.userId,
      email: "user@example.com",
      displayName: "User",
    });
    expect(JSON.stringify(result)).not.toContain("passwordHash");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("validates display name", async () => {
    const db = createDb();
    const service = new IdentityService(db as never);
    await expect(service.updateProfile(principal.userId, "   ")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.updateProfile(principal.userId, "a\u0000b")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.updateProfile(principal.userId, "a".repeat(81))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("returns 429 on the 6th recent failure without calling scrypt", async () => {
    const db = createDb({ authEvent: { count: vi.fn().mockResolvedValue(5), create: vi.fn() } });
    const service = new IdentityService(db as never);
    const verify = vi.spyOn(authCrypto, "verifyPassword").mockResolvedValue(true);
    const hash = vi.spyOn(authCrypto, "hashPassword").mockResolvedValue("new-hash");

    await expect(
      service.changePassword(principal, "current-password-123", "new-password-12345"),
    ).rejects.toMatchObject({ status: 429 });

    expect(verify).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(db.authEvent.create).toHaveBeenCalledWith({
      data: {
        userId: principal.userId,
        eventType: "auth.password_changed",
        outcome: "rate_limited",
      },
    });
    verify.mockRestore();
    hash.mockRestore();
  });

  it("writes failure event and throws INVALID_CREDENTIALS on wrong current password", async () => {
    const db = createDb();
    const service = new IdentityService(db as never);
    const verify = vi.spyOn(authCrypto, "verifyPassword").mockResolvedValue(false);
    await expect(
      service.changePassword(principal, "wrong-password-123", "new-password-12345"),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof UnauthorizedException)) return false;
      const response = error.getResponse() as { code?: string; message?: string };
      return response.code === "INVALID_CREDENTIALS" && response.message === "Invalid credentials";
    });
    expect(db.authEvent.create).toHaveBeenCalledWith({
      data: { userId: principal.userId, eventType: "auth.password_changed", outcome: "failure" },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    verify.mockRestore();
  });

  it("rejects same new password and updates in one transaction", async () => {
    const db = createDb();
    const service = new IdentityService(db as never);
    const verify = vi.spyOn(authCrypto, "verifyPassword").mockResolvedValue(true);
    const hash = vi.spyOn(authCrypto, "hashPassword").mockResolvedValue("new-hash");
    await expect(
      service.changePassword(principal, "same-password-123", "same-password-123"),
    ).rejects.toBeInstanceOf(BadRequestException);

    const result = await service.changePassword(
      principal,
      "current-password-123",
      "new-password-12345",
    );
    expect(result).toEqual({ ok: true, revokedSessions: 2 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db._tx.passwordCredential.upsert).toHaveBeenCalled();
    expect(db._tx.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: principal.userId,
          id: { not: principal.sessionId },
          revokedAt: null,
        }),
      }),
    );
    expect(db._tx.authEvent.create).toHaveBeenCalledWith({
      data: { userId: principal.userId, eventType: "auth.password_changed", outcome: "success" },
    });
    verify.mockRestore();
    hash.mockRestore();
  });
});
