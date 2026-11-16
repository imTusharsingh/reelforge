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
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/0/merge",
      GITHUB_EVENT_PATH: "",
      ...extraEnv,
    },
  });
}

async function writeMigration(root, name, sql = "SELECT 1;") {
  const directory = join(root, "packages", "database", "prisma", "migrations", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "migration.sql"), sql);
}

async function writeEvent(root, before) {
  const eventPath = join(root, "github-event.json");
  await writeFile(eventPath, JSON.stringify({ before }));
  return eventPath;
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

    // A branch push carrying the previous commit SHA still uses the merge base
    // with main, so editing a branch-only migration must pass.
    const pass = runScript(root, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/chore/migration",
      GITHUB_EVENT_PATH: await writeEvent(root, previousHead),
    });
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

test("direct main pushes compare migrations with github.event.before", async () => {
  const root = await mkdtemp(join(tmpdir(), "reelforge-migrations-main-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Migration Test"]);
    git(root, ["config", "user.email", "migration-test@example.com"]);

    await writeMigration(root, "20260101000000_merged");
    git(root, ["add", "packages"]);
    git(root, ["commit", "-m", "add merged migration"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const beforeAdd = git(root, ["rev-parse", "HEAD"]);
    await writeMigration(root, "20260102000000_main");
    git(root, ["add", "packages"]);
    git(root, ["commit", "-m", "add main migration"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const addPass = runScript(root, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: await writeEvent(root, beforeAdd),
    });
    assert.equal(addPass.status, 0, addPass.stderr || addPass.stdout);

    const beforeEdit = git(root, ["rev-parse", "HEAD"]);
    await writeMigration(root, "20260101000000_merged", "SELECT 3;");
    git(root, ["add", "packages"]);
    git(root, ["commit", "-m", "edit merged migration on main"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    const editFail = runScript(root, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: await writeEvent(root, beforeEdit),
    });
    assert.notEqual(editFail.status, 0);
    assert.match(editFail.stderr, /Existing migration files are immutable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
