import type { Prisma } from "@reelforge/database";

/** Serialize session issuance and credential/identity changes for the same account. */
export async function lockIdentityUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}
