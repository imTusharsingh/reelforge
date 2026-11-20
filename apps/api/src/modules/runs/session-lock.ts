import { ConflictException } from "@nestjs/common";
import { Client } from "pg";

export async function withSessionLock<T>(
  key: string,
  applicationName: string,
  message: string,
  lockLost: string,
  work: (assertLocked: () => Promise<void>) => Promise<T>,
): Promise<T> {
  // A standalone session keeps the application pool available while providers poll.
  const connectionString = process.env.DIRECT_DATABASE_URL?.trim() || process.env.DATABASE_URL;
  if (!connectionString?.trim()) throw new Error("A database connection string is required.");
  const client = new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
  });
  let disconnected = false;
  client.on("error", () => {
    disconnected = true;
  });
  try {
    await client.connect();
    const {
      rows: [lock],
    } = await client.query<{ acquired: boolean; pid: number }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired, pg_backend_pid() AS pid",
      [key],
    );
    if (lock?.acquired !== true) throw new ConflictException(message);

    return await work(async () => {
      const lost = new ConflictException(lockLost);
      if (disconnected) throw lost;
      const {
        rows: [status],
      } = await client
        .query<{ held: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
             WHERE pid = pg_backend_pid() AND pid = $2 AND locktype = 'advisory' AND granted
               AND objsubid = 1
               AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
               AND objid::bigint = (hashtextextended($1, 0) & 4294967295)
           ) AS held`,
          [key, lock.pid],
        )
        .catch(() => {
          throw lost;
        });
      if (disconnected || status?.held !== true) throw lost;
    });
  } finally {
    // Closing this session releases its sole advisory lock, including on failure.
    await client.end();
  }
}
