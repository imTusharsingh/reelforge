/** Owns disposable infrastructure; never migrates or seeds an existing database. */
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const runId = randomUUID();
const containers = [`reelforge-e2e-pg-${runId}`, `reelforge-e2e-redis-${runId}`];
const storage = resolve(".e2e", runId);
let child;
function run(command, args, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(command, args, {
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    child = processChild;
    let output = "";
    processChild.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    processChild.once("error", reject);
    processChild.once("exit", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
const docker = (args, capture = false) => run("docker", args, process.env, capture);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child?.kill(signal));
try {
  await mkdir(storage, { recursive: true });
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    containers[0],
    "-e",
    "POSTGRES_PASSWORD=e2e-only",
    "-e",
    "POSTGRES_DB=reelforge_e2e",
    "-p",
    "127.0.0.1::5432",
    "postgres:18.6-alpine",
  ]);
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    containers[1],
    "-p",
    "127.0.0.1::6379",
    "redis:8.2.3-alpine",
  ]);
  const pgPort = (await docker(["port", containers[0], "5432/tcp"], true)).split(":").at(-1);
  const redisPort = (await docker(["port", containers[1], "6379/tcp"], true)).split(":").at(-1);
  for (let attempt = 0; ; attempt++) {
    try {
      await docker(["exec", containers[0], "pg_isready", "-U", "postgres"]);
      break;
    } catch (error) {
      if (attempt === 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://postgres:e2e-only@127.0.0.1:${pgPort}/reelforge_e2e`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
    REELFORGE_E2E: "1",
    E2E_STORAGE_ROOT: storage,
    SOCIAL_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
    PUBLISH_SESSION_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  };
  await run("pnpm", ["db:generate"], env);
  await run("pnpm", ["db:migrate:deploy"], env);
  await run("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], env);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const name of containers) await docker(["rm", "--force", name]).catch(() => undefined);
  await rm(storage, { recursive: true, force: true });
}
