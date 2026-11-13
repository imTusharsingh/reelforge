import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "@reelforge/database";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("M27 migration PostgreSQL", () => {
  it("enforces workspace-scoped request keys and permits legacy null keys", async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const db = createDatabaseClient(databaseUrl);
    try {
      // Use an isolated temporary copy so no application data or foreign keys are changed.
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          "CREATE TEMP TABLE m27_posts (LIKE scheduled_posts INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP",
        );
        const workspace = randomUUID();
        const other = randomUUID();
        const request = randomUUID();
        const insert = async (space: string, key: string | null): Promise<void> => {
          await tx.$executeRaw`INSERT INTO m27_posts (id, workspace_id, channel_id, render_job_id, quality_review_run_id, disclosure_decision, disclosure_reason, created_by_user_id, updated_at, client_request_id, client_request_hash) VALUES (${randomUUID()}::uuid, ${space}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'NOT_REQUIRED', 'fixture', ${randomUUID()}::uuid, now(), ${key}::uuid, 'fixture')`;
        };
        await insert(workspace, request);
        await insert(other, request);
        await insert(workspace, null);
        await insert(workspace, null);
        await tx.$executeRawUnsafe("SAVEPOINT before_duplicate");
        await expect(insert(workspace, request)).rejects.toThrow();
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT before_duplicate");
        const rows = await tx.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*)::bigint AS count FROM m27_posts`;
        expect(rows[0]?.count).toBe(4n);
      });
    } finally {
      await db.$disconnect();
    }
  });

  it("returns one row when two concurrent creates use the same request key", async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const db = createDatabaseClient(databaseUrl);
    try {
      await db.$executeRawUnsafe("DROP TABLE IF EXISTS m27_request_key_race");
      await db.$executeRawUnsafe(
        "CREATE TABLE m27_request_key_race (workspace_id UUID NOT NULL, client_request_id UUID)",
      );
      await db.$executeRawUnsafe(
        "CREATE UNIQUE INDEX m27_request_key_race_key ON m27_request_key_race(workspace_id, client_request_id)",
      );
      try {
        const workspace = randomUUID();
        const request = randomUUID();
        const insert = (): Promise<number> =>
          db.$executeRaw`INSERT INTO m27_request_key_race (workspace_id, client_request_id) VALUES (${workspace}::uuid, ${request}::uuid)`;
        const results = await Promise.allSettled([insert(), insert()]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = results.filter((result) => result.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
          "duplicate key value violates unique constraint",
        );
        const rows = await db.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*)::bigint AS count FROM m27_request_key_race`;
        expect(rows[0]?.count).toBe(1n);
      } finally {
        await db.$executeRawUnsafe("DROP TABLE IF EXISTS m27_request_key_race");
      }
    } finally {
      await db.$disconnect();
    }
  });
});
