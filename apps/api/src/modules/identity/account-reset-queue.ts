import { randomUUID } from "node:crypto";
import type { Prisma } from "@reelforge/database";
import type { Database } from "./identity.types.js";
import { claimEmailQuota } from "./account-email-admission.js";

type ResetJob = { id: string; email: string; code: string | null; attempt: number };
const maxAttempts = 4;
const denied = Symbol("reset quota denied");

export class AccountResetQueue {
  public constructor(private readonly db: Database) {}

  public async enqueue(email: string, source: string): Promise<void> {
    await this.db
      .$transaction(async (tx) => {
        // Take the shared limit first to serialize capacity checks across replicas.
        const aggregate = await claimEmailQuota(tx, "reset:aggregate", "", 120, 60);
        const sourceAllowed = await claimEmailQuota(tx, "reset:source", source, 10, 60);
        const addressAllowed = await claimEmailQuota(tx, "reset:address", email, 1, 60);
        const enqueued = await tx.$executeRaw`
        INSERT INTO "AccountResetDelivery" ("id", "email", "expiresAt")
        SELECT ${randomUUID()}::uuid, ${email}, now() + interval '10 minutes'
        WHERE ${aggregate && sourceAllowed && addressAllowed}
          AND (SELECT count(*) FROM "AccountResetDelivery") < 500
      `;
        if (!enqueued) throw denied;
      })
      .catch((error: unknown) => {
        if (error !== denied) throw error;
      });
  }

  public async purge(): Promise<void> {
    await this.db.$executeRaw`
      DELETE FROM "AccountResetDelivery" WHERE "id" IN (
        SELECT "id" FROM "AccountResetDelivery"
        WHERE "expiresAt" <= now() OR ("attempt" >= ${maxAttempts} AND "availableAt" <= now())
        FOR UPDATE SKIP LOCKED
      )
    `;
    await this.db.$executeRaw`
      DELETE FROM "AccountEmailLimit" WHERE "key" IN (
        SELECT "key" FROM "AccountEmailLimit" WHERE "expiresAt" <= now()
        FOR UPDATE SKIP LOCKED
      )
    `;
  }

  public async take(): Promise<ResetJob | undefined> {
    const [job] = await this.db.$queryRaw<ResetJob[]>`
      UPDATE "AccountResetDelivery"
      SET "attempt" = "attempt" + 1, "availableAt" = now() + interval '60 seconds'
      WHERE "id" = (
        SELECT "id" FROM "AccountResetDelivery"
        WHERE "availableAt" <= now() AND "expiresAt" > now() AND "attempt" < ${maxAttempts}
        ORDER BY "availableAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "email", "code", "attempt"
    `;
    return job;
  }

  public async saveCode(tx: Prisma.TransactionClient, job: ResetJob, code: string): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE "AccountResetDelivery" SET "code" = ${code}
      WHERE "id" = ${job.id}::uuid AND "attempt" = ${job.attempt} AND "expiresAt" > now()
    `;
    if (!changed) throw new Error("Reset delivery lease expired");
  }

  public async finish(job: ResetJob, retry: boolean): Promise<void> {
    if (retry && job.attempt < maxAttempts) {
      await this.db.$executeRaw`
        UPDATE "AccountResetDelivery" SET "availableAt" = now() + ${30 * job.attempt} * interval '1 second'
        WHERE "id" = ${job.id}::uuid AND "attempt" = ${job.attempt}
      `;
      return;
    }
    await this.db.$executeRaw`
      DELETE FROM "AccountResetDelivery"
      WHERE "id" = ${job.id}::uuid AND "attempt" = ${job.attempt}
    `;
  }
}
