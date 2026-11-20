import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { AccountEmailService } from "./account-email.service.js";
import { hashPassword, hashSessionToken, verifyPassword } from "./auth.crypto.js";
import type { AccountEmailPort } from "./account-email.port.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("account email challenges with offline delivery", () => {
  const db = createDatabaseClient(databaseUrl ?? "postgresql://unused");
  const userIds: string[] = [];
  const password = "current-password-123";
  const replacement = "replacement-password-456";
  const send = vi.fn<AccountEmailPort["send"]>().mockResolvedValue(undefined);
  const account = new AccountEmailService(db, { send });
  beforeEach(() => send.mockClear());
  afterAll(async () => {
    await db.authEvent.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  async function fixture(): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    userIds.push(id);
    const email = `${id}@example.test`;
    await db.user.create({
      data: { id, email, credential: { create: { passwordHash: await hashPassword(password) } } },
    });
    await db.session.create({
      data: {
        userId: id,
        tokenHash: hashSessionToken(randomUUID()),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { id, email };
  }

  it("issues only one code during cooldown and consumes it atomically once", async () => {
    const user = await fixture();
    await account.requestReset("missing@example.test");
    expect(send).not.toHaveBeenCalled();
    await Promise.all([account.requestReset(user.email), account.requestReset(user.email)]);
    expect(send).toHaveBeenCalledTimes(1);
    const { code } = send.mock.calls[0]![0];
    const saved = await db.emailChallenge.findFirstOrThrow({ where: { userId: user.id } });
    expect(saved.tokenHash).toBe(hashSessionToken(code));
    await expect(account.confirmEmail(code)).rejects.toThrow("Invalid or expired");
    const results = await Promise.allSettled([
      account.resetPassword(code, replacement),
      account.resetPassword(code, replacement),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const credential = await db.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(await verifyPassword(replacement, credential.passwordHash)).toBe(true);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it("expires old codes and changes a mailbox only after verification", async () => {
    const user = await fixture();
    const target = `new-${user.email}`;
    await expect(account.requestEmailChange(user.id, target, "incorrect")).rejects.toThrow(
      "Invalid credentials",
    );
    await account.requestEmailChange(user.id, target, password);
    const first = send.mock.calls[0]![0];
    expect(first).toMatchObject({ to: target, purpose: "CHANGE_EMAIL" });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
    await db.emailChallenge.updateMany({
      where: { userId: user.id },
      data: { issuedAt: new Date(0), expiresAt: new Date(1) },
    });
    await expect(account.confirmEmail(first.code)).rejects.toThrow("Invalid or expired");
    await account.requestEmailChange(user.id, target, password);
    const second = send.mock.calls[1]![0];
    await account.confirmEmail(second.code);
    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved.email).toBe(target);
    expect(saved.emailVerifiedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    await expect(account.confirmEmail(second.code)).rejects.toThrow("Invalid or expired");
  });
});
