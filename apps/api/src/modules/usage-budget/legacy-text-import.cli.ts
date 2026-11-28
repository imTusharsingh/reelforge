import { parseArgs } from "node:util";
import { createDatabaseClient } from "@reelforge/database";
import { importLegacyTextAttempts } from "./legacy-text-import.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string" },
      apply: { type: "boolean" },
      "old-writers-drained": { type: "boolean" },
      "audit-id": { type: "string" },
    },
  });
  const workspaceId = values.workspace;
  const connection = process.env.DATABASE_URL;
  if (!workspaceId || !connection)
    throw new Error("Pass a workspace UUID and export DATABASE_URL.");
  const db = createDatabaseClient(connection);
  try {
    const report = await importLegacyTextAttempts(db, {
      workspaceId,
      ...(values.apply && { apply: true }),
      ...(values["old-writers-drained"] && { oldWritersDrained: true }),
      ...(values["audit-id"] && { auditId: values["audit-id"] }),
    });
    console.log(JSON.stringify(report, null, 2));
    if (
      report.unresolvedCreditIds.length ||
      report.attempts.some(
        (row) => row.action === "blocked" || row.action === "requires-reconciliation",
      )
    )
      process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
}

await main().catch(() => {
  console.error(
    "Legacy text import did not complete. Check the selected workspace, deployment drain, audit ID and database connectivity.",
  );
  process.exitCode = 1;
});
