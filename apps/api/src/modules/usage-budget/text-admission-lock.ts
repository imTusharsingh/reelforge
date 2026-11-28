import type { Run, Transaction } from "../runs/runs.types.js";

export async function lockBooks(tx: Transaction, run: Run): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${run.workspaceId}::uuid FOR NO KEY UPDATE`;
  await tx.$queryRaw`
    SELECT id FROM usage_budgets WHERE workspace_id = ${run.workspaceId}::uuid
       AND (channel_id IS NULL OR channel_id = ${run.channelId}::uuid) ORDER BY id FOR UPDATE`;
}
