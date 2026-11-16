import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { ProviderKeys } from "./provider-keys.js";
import { TokenVault } from "../social-accounts/token-vault.js";
const url = process.env.DATABASE_URL;
describe.skipIf(!url)("workspace provider key persistence", () => {
  const db = url ? createDatabaseClient(url) : undefined;
  const first = randomUUID(),
    second = randomUUID();
  const context = { workspaceId: first, userId: "verified-owner", role: "OWNER" as const };
  beforeAll(async () => {
    await db?.workspace.createMany({
      data: [
        { id: first, name: "provider-keys" },
        { id: second, name: "other-provider-keys" },
      ],
    });
  });
  afterAll(async () => {
    await db?.workspace.deleteMany({ where: { id: { in: [first, second] } } });
    await db?.$disconnect();
  });
  it("isolates encrypted provider keys by workspace and rejects viewer writes", async () => {
    if (!db) throw new Error("Postgres required");
    const keys = new ProviderKeys(db, new TokenVault(randomBytes(32).toString("base64url")));
    expect(await keys.write(context, "gemini", { key: "fixture-provider-secret" })).toEqual({
      configured: true,
    });
    const row = await db.providerKey.findUniqueOrThrow({
      where: { workspaceId_providerId: { workspaceId: first, providerId: "gemini" } },
    });
    expect(row.ciphertext).not.toContain("fixture-provider-secret");
    expect(row.schemaVersion).toBe("1.0");
    expect(await keys.configured({ ...context, workspaceId: second })).toEqual({
      gemini: false,
      xai: false,
    });
    await keys.remove({ ...context, workspaceId: second }, "gemini");
    expect((await keys.configured(context)).gemini).toBe(true);
    await expect(
      keys.write({ ...context, role: "VIEWER" }, "gemini", { key: "forbidden" }),
    ).rejects.toThrow();
    await keys.remove(context, "gemini");
    expect((await keys.configured(context)).gemini).toBe(false);
  });
});
