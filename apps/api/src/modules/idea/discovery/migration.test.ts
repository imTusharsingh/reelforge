import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrations = new URL(
  "../../../../../../packages/database/prisma/migrations/",
  import.meta.url,
);
const name = "20261125010000_v10_discovery_learning";
const sql = readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8");
const schema = readFileSync(new URL("../schema.prisma", migrations), "utf8");

describe("V10 migration ordering and tenant relations", () => {
  it("follows the newest main migration identified by the review", () => {
    const mainLatest = "20261124011300_provider_keys";
    const entries = readdirSync(migrations);
    expect(entries).toContain(mainLatest);
    expect(name > mainLatest).toBe(true);
    expect(entries).toContain(name);
    expect(entries).not.toContain("20261116180000_v10_discovery_learning");
  });
  it("cascades both workspace foreign keys and the workspace-scoped channel foreign key", () => {
    const normalized = sql.replace(/\s+/g, " ");
    for (const table of ["discovery_records", "discovery_quotas"])
      expect(normalized).toContain(
        `ALTER TABLE ${table} ADD CONSTRAINT ${table}_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE`,
      );
    expect(normalized).toContain(
      "ALTER TABLE discovery_records ADD CONSTRAINT discovery_records_workspace_id_channel_id_fkey FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE ON UPDATE CASCADE",
    );
  });
  it("models the same cascades and reverse relations in Prisma", () => {
    const record = schema.split("model DiscoveryRecord {")[1]!.split("\n}")[0]!;
    const quota = schema.split("model DiscoveryQuota {")[1]!.split("\n}")[0]!;
    for (const model of [record, quota])
      expect(model).toContain(
        "@relation(fields: [workspaceId], references: [id], onDelete: Cascade)",
      );
    expect(record).toContain(
      "@relation(fields: [workspaceId, channelId], references: [workspaceId, id], onDelete: Cascade)",
    );
    expect(schema.split("model Workspace {")[1]!.split("\n}")[0]).toMatch(
      /discoveryRecords\s+DiscoveryRecord\[\]/,
    );
    expect(schema.split("model Workspace {")[1]!.split("\n}")[0]).toMatch(
      /discoveryQuotas\s+DiscoveryQuota\[\]/,
    );
    expect(schema.split("model Channel {")[1]!.split("\n}")[0]).toMatch(
      /discoveryRecords\s+DiscoveryRecord\[\]/,
    );
  });
});
