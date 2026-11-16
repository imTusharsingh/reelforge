import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-migrations.mjs", import.meta.url));

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runScript(cwd, extraEnv = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
      MIGRATION_BASE_REF: "origin/main",
      ...extraEnv,
    },
  });
}

async function writeMigration(root, name, sql = "SELECT 1;") {
  const directory = join(root, "packages", "database", "prisma", "migrations", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "migration.sql"), sql);
}

test("push ranges only treat migrations already on main as immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "reelforge-migrations-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Migration Test"]);
    git(root, ["config", "user.email", "migration-test@example.com"]);

    await writeMigration(root, "20260101000000_merged");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "add merged migration"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["switch", "-c", "chore/migration"]);

    await writeMigration(root, "20260102000000_branch");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "add branch migration"]);
    const previousHead = git(root, ["rev-parse", "HEAD"]);

    await writeMigration(root, "20260102000000_branch", "SELECT 2;");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "edit branch migration"]);

    // Simulate a push run carrying the previous commit SHA. Only migrations
    // present on main may be treated as immutable, so this edit must pass.
    const pass = runScript(root, { MIGRATION_BASE_SHA: previousHead });
    assert.equal(pass.status, 0, pass.stderr || pass.stdout);

    // A real edit to a migration already on main still fails.
    await writeMigration(root, "20260101000000_merged", "SELECT 3;");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "edit merged migration"]);

    const fail = runScript(root);
    assert.notEqual(fail.status, 0);
    assert.match(fail.stderr, /Existing migration files are immutable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
