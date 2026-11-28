import type { Transaction } from "../runs/runs.types.js";

export async function lockBooks(
  tx: Transaction,
  scope: { workspaceId: string; channelId: string | null },
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${scope.workspaceId}::uuid FOR NO KEY UPDATE`;
  await tx.$queryRaw`
    SELECT id FROM usage_budgets WHERE workspace_id = ${scope.workspaceId}::uuid
       AND (channel_id IS NULL OR channel_id = ${scope.channelId}::uuid) ORDER BY id FOR UPDATE`;
}
