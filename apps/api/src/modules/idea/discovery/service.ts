import { discoveryEstimate } from "./text-calls.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { type RankedIdea } from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../../identity/identity.types.js";
import { DiscoveryLearningSource } from "../../analytics/discovery-learning-source.js";
import { rankCandidates } from "./scoring.js";
import { DiscoveryScout } from "./scout.js";
import { DiscoveryStore } from "./store.js";

export function discoverySlot(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // One scout scan per channel/day; quota counters remain project-wide.
  return parts;
}
@Injectable()
export class DiscoveryService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly store: DiscoveryStore,
    private readonly scout: DiscoveryScout,
    private readonly analytics: DiscoveryLearningSource,
  ) {}
  public async tick(
    context: WorkspaceContext,
    channelId: string,
    now = new Date(),
  ): Promise<RankedIdea[]> {
    discoveryEstimate();
    const brief = await this.store.brief(context, channelId);
    const slot = discoverySlot(now, brief.cadence.timezone);
    const text = await this.scout.textPort(context).catch(() => {
      console.error(
        "[discovery-worker] check Gemini credentials and model configuration",
        channelId,
      );
      throw new Error("Discovery provider configuration unavailable");
    });
    if (!(await this.store.claim(context, channelId, slot, now))) return [];
    try {
      const samples = await this.analytics.samples(context, channelId, now);
      const state = await this.store.learn(context, brief, samples, now);
      const history = await this.store.history(context, channelId);
      const effectiveBrief = {
        ...brief,
        formatMix: Object.entries(state.formatMix).map(([formatKey, weight]) => ({
          formatKey,
          weight,
        })),
      };
      const candidates = await this.scout.discover(
        context,
        effectiveBrief,
        history.map((row) => row.topic),
        this.analytics.sources(samples),
        `discovery:${context.workspaceId}:${channelId}:${slot}`,
        now,
        text,
      );
      const ranked = rankCandidates(
        candidates,
        brief,
        history.map((row) => ({ topic: row.topic, createdAt: row.approvedAt ?? row.createdAt })),
        state,
        now,
      ).map((idea) => ({ ...idea, id: randomUUID() }));
      await this.store.finish(context, brief, slot, ranked, now);
      return ranked;
    } catch (error) {
      await this.store.failure(context, channelId, slot);
      throw error;
    }
  }
  public async scheduledTick(now = new Date()): Promise<void> {
    if (process.env.DISCOVERY_ENABLED !== "true") return;
    try {
      discoveryEstimate();
    } catch {
      console.error(
        "[discovery-worker] configure a positive DISCOVERY_TEXT_ESTIMATE_USD before scheduling discovery",
      );
      return;
    }
    const channels = await this.db.channel.findMany({
      where: { status: "ACTIVE", channelBriefRows: { some: {} } },
      select: { id: true, workspaceId: true },
    });
    for (const channel of channels) {
      const member = await this.db.workspaceMembership.findFirst({
        where: { workspaceId: channel.workspaceId, role: "OWNER" },
        orderBy: { createdAt: "asc" },
      });
      if (!member) continue;
      try {
        await this.tick(
          { workspaceId: member.workspaceId, userId: member.userId, role: member.role },
          channel.id,
          now,
        );
      } catch {
        // Details may contain provider keys; persisted tick and M08 ledger contain safe diagnostics.
        console.error("[discovery-worker] channel tick failed", channel.id);
      }
    }
  }
}
