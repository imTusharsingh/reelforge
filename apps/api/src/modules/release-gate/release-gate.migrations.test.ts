import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * M20-T02: migrations are integrated once and in the right order (QUALITY_GATES Gate 3).
 * Reads the committed migration folders only; no database or network is used.
 */
const migrationsDir = new URL(
  "../../../../../packages/database/prisma/migrations/",
  import.meta.url,
);

function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("M20 release gate: migration ordering", () => {
  it("uses unique, strictly increasing 14-digit timestamps with one migration.sql each", () => {
    const names = migrationNames();
    expect(names.length).toBeGreaterThanOrEqual(27);
    const stamps = names.map((name) => {
      const match = /^(\d{14})_[a-z0-9_]+$/.exec(name);
      expect(match, `bad migration folder name: ${name}`).not.toBeNull();
      return match![1]!;
    });
    expect(new Set(stamps).size).toBe(stamps.length);
    for (let index = 1; index < stamps.length; index += 1) {
      expect(stamps[index]! > stamps[index - 1]!).toBe(true);
    }
    for (const name of names) {
      const file = new URL(`${name}/migration.sql`, migrationsDir);
      expect(existsSync(file), `${name} has no migration.sql`).toBe(true);
      expect(readFileSync(file, "utf8").trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the Postgres provider lock", () => {
    const lock = readFileSync(new URL("migration_lock.toml", migrationsDir), "utf8");
    expect(lock).toContain('provider = "postgresql"');
  });
});
