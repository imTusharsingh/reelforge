import { createHash } from "node:crypto";
import type { Prisma } from "@reelforge/database";

export async function claimEmailQuota(
  tx: Prisma.TransactionClient,
  scope: string,
  subject: string,
  limit: number,
  seconds: number,
): Promise<boolean> {
  const key = `${scope}:${createHash("sha256").update(subject).digest("hex")}`;
  const count = await tx.$executeRaw`
    INSERT INTO "AccountEmailLimit" ("key", "count", "expiresAt")
    VALUES (${key}, 1, now() + ${seconds} * interval '1 second')
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "AccountEmailLimit"."expiresAt" <= now()
                    THEN 1 ELSE "AccountEmailLimit"."count" + 1 END,
      "expiresAt" = CASE WHEN "AccountEmailLimit"."expiresAt" <= now()
                        THEN EXCLUDED."expiresAt" ELSE "AccountEmailLimit"."expiresAt" END
    WHERE "AccountEmailLimit"."expiresAt" <= now() OR "AccountEmailLimit"."count" < ${limit}
  `;
  return count === 1;
}
