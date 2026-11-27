import { StoredChannelBriefSchema, type ChannelBrief } from "@reelforge/contracts";
import type { Database } from "../identity/identity.types.js";
import type { BudgetStatusView } from "./usage-budget.types.js";
export type BudgetRecord = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string | null;
  scopeKey: string;
  currency: string;
  dailyLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  timezone: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export function admissionBudgets(
  budgets: BudgetRecord[],
  brief?: ChannelBrief["budgetPolicy"],
): BudgetRecord[] {
  if (!brief) return budgets;
  const workspace = budgets.find((budget) => !budget.channelId);
  const tighter = (configured: bigint | null, pinned: number): bigint =>
    configured !== null && configured < BigInt(pinned) ? configured : BigInt(pinned);
  const effective = {
    ...(workspace ?? budgets[0]!),
    channelId: null,
    timezone: workspace?.timezone ?? "UTC",
    dailyLimitMinor: tighter(workspace?.dailyLimitMinor ?? null, brief.dailyLimitMinor),
    monthlyLimitMinor: tighter(workspace?.monthlyLimitMinor ?? null, brief.monthlyLimitMinor),
  };
  return [effective, ...budgets.filter((budget) => budget.channelId)];
}

export async function displayBudgets(
  db: Database,
  workspaceId: string,
  budgets: BudgetRecord[],
  statuses: BudgetStatusView[],
  channelId?: string | null,
): Promise<BudgetStatusView[]> {
  if (!statuses.length) return statuses;
  const channels = await db.channel.findMany({
    where: { workspaceId, ...(channelId && { id: channelId }), channelBriefRows: { some: {} } },
    select: {
      id: true,
      name: true,
      channelBriefRows: { orderBy: { version: "desc" }, take: 1, select: { document: true } },
    },
  });
  const caps = channels.flatMap((channel) => {
    const brief = StoredChannelBriefSchema.parse(channel.channelBriefRows[0]!.document);
    const relevant = budgets.filter(
      (budget) => !budget.channelId || budget.channelId === channel.id,
    );
    if (!relevant.length) return [];
    const limits = admissionBudgets(relevant, brief.budgetPolicy);
    return {
      channelId: channel.id,
      name: channel.name,
      dailyLimitMinor: Math.min(...limits.map((b) => Number(b.dailyLimitMinor ?? Infinity))),
      monthlyLimitMinor: Math.min(...limits.map((b) => Number(b.monthlyLimitMinor ?? Infinity))),
    };
  });
  return statuses.map((status) => ({
    ...status,
    effectiveBriefCaps: caps.filter((c) => !status.channelId || status.channelId === c.channelId),
  }));
}
