import { ConflictException } from "@nestjs/common";
import { RECOVERY_PRINCIPAL, type Transaction } from "../runs/runs.types.js";
import { postMediaCredit } from "./provider-charge-credit.js";

type Link = { adjustmentId: string; providerRequestId: string; operationKey: string };
/** Match one supplemental audit to the immutable original row and the exact provider charge. */
export async function provenMediaLinks(
  tx: Transaction,
  workspaceId: string,
  candidates: string[],
): Promise<Link[]> {
  if (!candidates.length) return [];
  return tx.$queryRaw<Link[]>`
    SELECT c.id AS "adjustmentId", p.id AS "providerRequestId", detail->>'operationKey' AS "operationKey"
    FROM usage_adjustments c
    JOIN usage_audit_records a ON a.workspace_id = c.workspace_id AND a.adjustment_id = c.id
    CROSS JOIN LATERAL (SELECT a.after->'adjustment' AS detail) d
    JOIN provider_requests p ON p.id::text = detail->>'providerRequestId'
    WHERE c.workspace_id = ${workspaceId}::uuid AND c.id = ANY(${candidates}::uuid[])
      AND p.workspace_id = c.workspace_id AND p.channel_id IS NOT DISTINCT FROM c.channel_id AND p.currency = c.currency
      AND c.operation_key IS NULL AND c.text_attempt_id IS NULL AND c.provider_request_id IS NULL AND c.kind = 'CREDIT'
      AND a.action = 'CREDIT' AND a.actor_user_id = c.actor_user_id AND a.correlation_id = c.correlation_id
      AND detail @> jsonb_build_object('id', c.id, 'channelId', c.channel_id, 'currency', c.currency, 'amountMinor', c.amount_minor)
      AND jsonb_typeof(detail->'operationKey') = 'string' AND length(trim(detail->>'operationKey')) BETWEEN 1 AND 200
      AND NOT (detail ? 'textAttemptId')
      AND NOT EXISTS (SELECT FROM usage_audit_records other WHERE other.workspace_id = c.workspace_id
          AND other.adjustment_id = c.id AND other.id <> a.id
          AND (other.after->'adjustment' ?| array['textAttemptId','providerRequestId']))
    ORDER BY c.id`;
}

export async function linkMediaCredit(
  tx: Transaction,
  workspaceId: string,
  link: Link,
  auditId: string,
): Promise<void> {
  const row = await tx.usageAdjustment.findFirstOrThrow({
    where: { workspaceId, id: link.adjustmentId },
  });
  const currency = await postMediaCredit(
    tx,
    { workspaceId, providerRequestId: link.providerRequestId, now: new Date() },
    row.channelId,
    row.amountMinor,
  );
  if (currency !== row.currency)
    throw new ConflictException("Credit currency does not match media charge");
  await tx.usageAdjustment.update({
    where: { id: row.id },
    data: { providerRequestId: link.providerRequestId, operationKey: link.operationKey },
  });
  await tx.usageAuditRecord.create({
    data: {
      workspaceId,
      action: "CREDIT",
      actorUserId: RECOVERY_PRINCIPAL,
      correlationId: row.correlationId,
      adjustmentId: row.id,
      reason: "Historical media credit attributed",
      before: { providerRequestId: null },
      after: { auditId, ...link },
    },
  });
}
