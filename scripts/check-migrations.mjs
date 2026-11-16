import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const migrationsDir = join("packages", "database", "prisma", "migrations");
const mainRef = process.env.MIGRATION_BASE_REF ?? "origin/main";
const directMainPush =
  process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF === "refs/heads/main";
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

function detail(error) {
  return typeof error.stderr === "string" ? error.stderr.trim() : error.message;
}

async function git(args, failure) {
  try {
    const { stdout } = await execFileAsync("git", args);
    return stdout;
  } catch (error) {
    throw new Error(`Migration guard could not ${failure}: ${detail(error)}`);
  }
}

async function resolveMergeBase() {
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", mainRef, "HEAD"]);
    const mergeBase = stdout.trim();
    if (mergeBase) return mergeBase;
  } catch (error) {
    throw new Error(
      `Migration guard needs ${mainRef}; fetch it with "git fetch origin main:refs/remotes/origin/main" or set MIGRATION_BASE_REF. ${detail(error)}`,
    );
  }
  throw new Error(`Could not find a merge base between ${mainRef} and HEAD.`);
}

async function resolvePushBefore() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      "Migration guard cannot read github.event.before: GITHUB_EVENT_PATH is unavailable on this main push.",
    );
  }
  let event;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch (error) {
    throw new Error(`Migration guard could not read github.event.before: ${error.message}`);
  }
  const before = typeof event.before === "string" ? event.before.trim() : "";
  if (!before || /^0+$/.test(before)) return "";
  return (
    await git(["rev-parse", "--verify", `${before}^{commit}`], `resolve push before ${before}`)
  ).trim();
}

// Branch pushes and PRs compare against the merge base with main. A direct push
// to main compares against github.event.before, because its merge base is HEAD.
const mergeBase = await resolveMergeBase();
const pushBefore = directMainPush ? await resolvePushBefore() : "";
const base = pushBefore || mergeBase;
const diff = await git(
  ["diff", "--name-status", base, "HEAD", "--", `${migrationsDir}/`],
  `compare migrations from ${base}`,
);
const changedExisting = diff
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((line) => /^[MDCR]/.test(line));
if (changedExisting.length > 0) {
  throw new Error(
    `Existing migration files are immutable; only new migration directories may be added:\n${changedExisting.join("\n")}`,
  );
}

console.log(
  `Migration guard passed: ${migrationNames.length} ordered migrations; existing files immutable.`,
);
