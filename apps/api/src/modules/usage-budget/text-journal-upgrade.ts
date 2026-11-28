import { ConflictException } from "@nestjs/common";
import { isDefinitiveProviderRejection } from "@reelforge/ai-providers";
import { z } from "zod";

export type Evidence = {
  sequence: number;
  kind: string;
  nonce: string | null;
  data: unknown;
  eventKey?: string;
};
const detail = z.object({
  dispatchKey: z.string(),
  code: z.string().optional(),
  httpStatus: z.unknown().optional(),
  source: z.string().optional(),
  actualMinor: z.int().optional().nullable(),
});
const repair = z.object({
  dispatchKey: z.string(),
  auditId: z.string().min(1),
  rejections: z
    .array(z.object({ sequence: z.int().positive(), eventKey: z.string(), reason: z.string() }))
    .min(1),
});
type Rejection = z.infer<typeof repair>["rejections"][number];

export function definitiveJournalRejection(event: Evidence): boolean {
  const data = detail.parse(event.data);
  if (data.httpStatus !== undefined && data.code)
    return (
      typeof data.httpStatus === "number" &&
      isDefinitiveProviderRejection(data.httpStatus, data.code)
    );
  return (
    !!event.nonce?.startsWith("legacy:") &&
    !!event.eventKey?.startsWith("legacy:REJECTED:") &&
    data.source === "matched-provider" &&
    ["PROVIDER_UNAUTHENTICATED", "PROVIDER_PERMISSION_DENIED"].includes(data.code ?? "")
  );
}

/** Only the two previously writable contradictions can be excluded by audited cutover. */
export function journalRejections(
  dispatchKey: string,
  rows: readonly Evidence[],
): {
  pending: Rejection[];
  repaired: Set<number>;
} {
  const pending = new Map<number, Rejection>();
  const repaired = new Set<number>();
  let nonce: string | null = null;
  let billed = false;
  for (const row of rows) {
    if (row.kind === "ARMED") nonce = row.nonce;
    if (!nonce || nonce !== row.nonce) continue;
    if (row.kind === "JOURNAL_REPAIR") {
      const data = repair.parse(row.data);
      for (const target of data.rejections) {
        const found = pending.get(target.sequence);
        if (
          data.dispatchKey !== dispatchKey ||
          !found ||
          found.eventKey !== target.eventKey ||
          found.reason !== target.reason
        )
          throw new ConflictException("Journal repair does not match historical rejection");
        pending.delete(target.sequence);
        repaired.add(target.sequence);
      }
      continue;
    }
    if (!["SUCCEEDED", "RECOVERED_RECEIPT", "REJECTED"].includes(row.kind)) continue;
    const data = detail.parse(row.data);
    if (data.dispatchKey !== dispatchKey) continue;
    if (row.kind !== "REJECTED") {
      if (data.source !== "owner_reported" && (data.actualMinor ?? 0) > 0) billed = true;
    } else if (row.eventKey && data.code && (billed || !definitiveJournalRejection(row))) {
      pending.set(row.sequence, {
        sequence: row.sequence,
        eventKey: row.eventKey,
        reason: billed ? "positive prior receipt" : "unproven rejection status",
      });
    }
  }
  return { pending: [...pending.values()], repaired };
}
