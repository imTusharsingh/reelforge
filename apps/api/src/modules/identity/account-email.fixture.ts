import { randomUUID } from "node:crypto";
import { createSessionToken, hashPassword, hashSessionToken } from "./auth.crypto.js";
import type { Database } from "./identity.types.js";

export async function createAccountFixture(
  db: Database,
  password: string,
  email = `${randomUUID()}@example.test`,
): Promise<{ id: string; email: string; token: string }> {
  const token = createSessionToken();
  const { id } = await db.user.create({
    data: {
      email,
      credential: { create: { passwordHash: await hashPassword(password) } },
      sessions: {
        create: { tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 600_000) },
      },
    },
  });
  return { id, email, token };
}
