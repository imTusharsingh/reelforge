import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDatabaseClient } from "@reelforge/database";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AccountEmailService } from "../identity/account-email.service.js";
import { createSessionToken, hashPassword, hashSessionToken } from "../identity/auth.crypto.js";
import { IdentityService } from "../identity/identity.service.js";
import { ProviderVideoHealth } from "../openai/provider-video-health.js";
import { AssetService } from "./asset.service.js";
import { sha256Hex } from "./storage/checksum.js";
import { LocalFilesystemStorageAdapter } from "./storage/local-storage.adapter.js";

const baseLastMigration = "20261125200000_v9_publishing_slots";
const databaseRoot = fileURLToPath(new URL("../../../../../packages/database/", import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
const body = Buffer.from("immutable legacy asset bytes");
const checksum = sha256Hex(body);
const workspaceId = randomUUID();
const userId = randomUUID();
const assetId = randomUUID();
const email = "upgrade@example.test";
const objectKey = "assets/upgrade/original.png";
const token = createSessionToken();

async function seedBase(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("INSERT INTO workspaces (id, name, updated_at) VALUES ($1, $2, now())", [
      workspaceId,
      "Legacy workspace",
    ]);
    await client.query("INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())", [
      userId,
      email,
    ]);
    await client.query(
      "INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)",
      [userId, await hashPassword("legacy-password-123")],
    );
    await client.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [userId, hashSessionToken(token)],
    );
    await client.query(
      "INSERT INTO workspace_memberships (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')",
      [randomUUID(), workspaceId, userId],
    );
    await client.query(
      `
      INSERT INTO assets (id, workspace_id, object_key, root_asset_id, media_type, byte_size, checksum_sha256, status, updated_at)
      VALUES ($1, $2, $3, $1, 'image/png', $4, $5, 'PUBLISHED', now())
    `,
      [assetId, workspaceId, objectKey, body.length, checksum],
    );
  } finally {
    await client.end();
  }
}

async function deploy(root: string, url: string, current: boolean): Promise<void> {
  const source = join(databaseRoot, "prisma/migrations");
  const migrations = join(root, "migrations");
  await mkdir(migrations, { recursive: true });
  const entries = await readdir(source);
  for (const entry of entries) {
    if (current || entry <= baseLastMigration || entry === "migration_lock.toml")
      await cp(join(source, entry), join(migrations, entry), { recursive: true });
  }
  const config = join(root, "prisma.config.mjs");
  await writeFile(
    config,
    `export default { schema: ${JSON.stringify(join(databaseRoot, "prisma/schema.prisma"))}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
  );
  await promisify(execFile)(
    join(databaseRoot, "node_modules/.bin/prisma"),
    ["migrate", "deploy", "--config", config],
    {
      cwd: databaseRoot,
      env: { ...process.env, DATABASE_URL: url },
      timeout: 60_000,
    },
  );
}

describe.skipIf(!databaseUrl)("PR #146 populated database upgrade", () => {
  it("deploys over base rows and exercises the first session, challenge, range read and health write", async () => {
    const root = await mkdtemp(join(tmpdir(), "reelforge-upgrade-"));
    const base = new URL(databaseUrl!);
    base.searchParams.delete("schema");
    const name = `rf_upgrade_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: base.href });
    base.pathname = `/${name}`;
    const db = createDatabaseClient(base.href);
    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      await deploy(root, base.href, false);
      await seedBase(base.href);
      await deploy(root, base.href, true);

      const identity = new IdentityService(db);
      expect(await identity.principalForToken(token)).toMatchObject({ userId });
      expect(await db.user.findUnique({ where: { id: userId } })).toMatchObject({
        emailVerifiedAt: null,
      });

      const send = vi.fn().mockResolvedValue(undefined);
      const account = new AccountEmailService(db, { send });
      await account.requestReset(email, "upgrade");
      await account.processResetDelivery();
      expect(send).toHaveBeenCalledWith({
        to: email,
        purpose: "RESET_PASSWORD",
        code: expect.any(String),
      });
      expect(await db.emailChallenge.count({ where: { userId } })).toBe(1);

      const storage = new LocalFilesystemStorageAdapter(join(root, "objects"));
      await storage.putObject({ workspaceId, objectKey, body, contentType: "image/png" });
      const assets = new AssetService(db, storage);
      const context = { workspaceId, userId, role: "OWNER" as const };
      expect(await db.asset.findUnique({ where: { id: assetId } })).toMatchObject({
        deliveryChunkHashes: null,
      });
      const media = await assets.getContent(context, assetId, 1, { rangeHeader: "bytes=2-5" });
      expect(media.body).toEqual(body.subarray(2, 6));
      expect(media.bodyOffset).toBe(2);
      expect(await db.asset.findUnique({ where: { id: assetId } })).toMatchObject({
        deliveryChunkHashes: [checksum],
      });

      const health = new ProviderVideoHealth(db);
      expect((await health.state(workspaceId)).size).toBe(0);
      await health.record(workspaceId, "gemini", "ACCEPTED");
      expect((await health.state(workspaceId)).get("gemini")).toMatchObject({
        calls: 1,
        accepted: 1,
      });
    } finally {
      await db.$disconnect();
      await admin
        .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        .finally(() => admin.end());
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
