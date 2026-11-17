import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Database } from "../../identity/identity.types.js";

export function quotaPeriods(now: Date): { day: string; month: string } {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { day, month: day.slice(0, 7) };
}
export type QuotaBucket = { id: string; limit: number };
export function quotaBuckets(kind: "grounding" | "youtube", now: Date): QuotaBucket[] {
  const { day, month } = quotaPeriods(now);
  // Conservative global project pools, including workspaces using separate credentials.
  if (kind === "grounding")
    return [
      { id: `gemini:day:${day}`, limit: 1500 },
      { id: `gemini:month:${month}`, limit: 5000 },
    ];
  return [
    { id: `youtube:search:${day}`, limit: 100 },
    { id: `youtube:scout:${day}`, limit: 20 },
  ];
}
@Injectable()
export class DiscoveryQuotaService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}
  public async reserve(
    workspaceId: string,
    kind: "grounding" | "youtube",
    now: Date,
  ): Promise<boolean> {
    try {
      await this.db.$transaction(async (tx) => {
        for (const bucket of quotaBuckets(kind, now)) {
          const row = await tx.discoveryQuota.upsert({
            where: { id: bucket.id },
            create: { id: bucket.id, workspaceId, used: 1 },
            update: { used: { increment: 1 } },
          });
          if (row.used > bucket.limit) throw new QuotaExhausted();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof QuotaExhausted) return false;
      throw error;
    }
  }
}
class QuotaExhausted extends Error {}
export function stableKey(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
