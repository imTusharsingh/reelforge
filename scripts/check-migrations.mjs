import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const migrationsDir = join("packages", "database", "prisma", "migrations");
const entries = (await readdir(migrationsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const migrationNames = entries.filter((name) => /^\d{14}_[a-z0-9_]+$/.test(name));
if (migrationNames.length !== entries.length || migrationNames.length === 0) {
  throw new Error("Every migration directory must use a unique YYYYMMDDHHMMSS_name format.");
}

const timestamps = migrationNames.map((name) => name.slice(0, 14));
if (new Set(timestamps).size !== timestamps.length) {
  throw new Error("Migration timestamps must be unique to preserve deterministic ordering.");
}

for (const name of migrationNames) {
  const sqlPath = join(migrationsDir, name, "migration.sql");
  const sql = await readFile(sqlPath, "utf8");
  if (sql.trim().length === 0) {
    throw new Error(`${sqlPath} is empty.`);
  }
}

const baseSha = process.env.MIGRATION_BASE_SHA;
if (baseSha && !/^0+$/.test(baseSha)) {
  const { stdout } = await execFileAsync("git", [
    "diff",
    "--name-status",
    baseSha,
    "HEAD",
    "--",
    `${migrationsDir}/`,
  ]);
  const changedExisting = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((line) => /^[MDCR]/.test(line));
  if (changedExisting.length > 0) {
    throw new Error(
      `Existing migration files are immutable; only new migration directories may be added:\n${changedExisting.join("\n")}`,
    );
  }
}

console.log(
  `Migration guard passed: ${migrationNames.length} ordered migrations; existing files immutable.`,
);
