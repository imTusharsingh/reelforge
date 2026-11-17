import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { Prisma } from "@reelforge/database";
import type { PublishedPostRecord, PublishedPostContext, RankedIdea } from "@reelforge/contracts";
import { RankedIdeaSchema } from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { PublishingService } from "../publishing/publishing.service.js";
import { normalizeTopic } from "../idea/discovery/scoring.js";
import type { DiscoverySource, LearningSample } from "../idea/discovery/types.js";

@Injectable()
export class DiscoveryLearningSource {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly publishing: PublishingService,
  ) {}
  public async samples(
    context: WorkspaceContext,
    channelId: string,
    now: Date,
  ): Promise<LearningSample[]> {
    const [snapshots, posts, ticks] = await Promise.all([
      this.db.analyticsMetricSnapshot.findMany({
        where: {
          workspaceId: context.workspaceId,
          channelId,
          entityGranularity: "VIDEO",
          periodStart: { gte: new Date(now.getTime() - 28 * 86400000) },
          periodEnd: { lt: now },
        },
        include: { definition: { select: { key: true } } },
        orderBy: [{ collectedAt: "desc" }, { id: "desc" }],
      }),
      this.publishedRecords(context),
      this.db.discoveryRecord.findMany({
        where: { workspaceId: context.workspaceId, channelId, kind: "RESULT" },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);
    const eligible = posts.filter(
      (post) => post.channelId === channelId && post.platform === "YOUTUBE",
    );
    const contexts: Awaited<ReturnType<PublishingService["listPublishedPostContexts"]>> = [];
    for (let offset = 0; offset < eligible.length; offset += 500)
      contexts.push(
        ...(await this.publishing.listPublishedPostContexts(
          context,
          eligible.slice(offset, offset + 500).map((post) => post.scheduledPostId),
        )),
      );
    const ideas = ticks.flatMap((tick) => z.array(RankedIdeaSchema).parse(tick.document));
    return joinLearningSamples(eligible, contexts, ideas, snapshots);
  }

  private async publishedRecords(
    context: WorkspaceContext,
  ): ReturnType<PublishingService["listPublishedRecords"]> {
    const records: Awaited<ReturnType<PublishingService["listPublishedRecords"]>> = [];
    let after: string | null = null,
      afterId: string | null = null;
    for (;;) {
      const batch = await this.publishing.listPublishedRecords(context, after, 100, afterId);
      records.push(...batch);
      if (batch.length < 100) return records;
      const last = batch.at(-1)!;
      after = last.publishedAt;
      afterId = last.destinationId;
    }
  }
  public sources(samples: readonly LearningSample[]): DiscoverySource[] {
    return samples.slice(0, 10).map((sample) => ({
      kind: "ANALYTICS",
      title: `Channel Short retention ${(sample.retention * 100).toFixed(1)}%`,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(sample.videoId)}`,
    }));
  }
}

type Snapshot = Prisma.AnalyticsMetricSnapshotGetPayload<{
  include: { definition: { select: { key: true } } };
}>;
function joinLearningSamples(
  eligible: readonly PublishedPostRecord[],
  contexts: readonly PublishedPostContext[],
  ideas: readonly RankedIdea[],
  snapshots: readonly Snapshot[],
): LearningSample[] {
  const latest = new Map<string, (typeof snapshots)[number]>();
  for (const row of snapshots) {
    const key = `${row.socialAccountId}:${row.remoteEntityId}:${row.definition.key}:${row.periodStart.toISOString()}:${row.periodEnd.toISOString()}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return eligible.flatMap((post) => {
    const published = contexts.find((item) => item.scheduledPostId === post.scheduledPostId);
    const idea = ideas.find(
      (item) => published?.topic && normalizeTopic(item.topic) === normalizeTopic(published.topic),
    );
    if (!idea || !published?.durationSeconds) return [];
    const rows = [...latest.values()].filter(
      (row) =>
        row.socialAccountId === post.accountId &&
        row.remoteEntityId === post.platformPostId &&
        row.availability === "AVAILABLE" &&
        row.completeness === "COMPLETE" &&
        row.value !== null,
    );
    const views = rows.filter((row) => row.definition.key === "views");
    const watch = rows.filter((row) => row.definition.key === "estimatedMinutesWatched");
    const paired = views.flatMap((view) => {
      const match = watch.find(
        (row) =>
          row.periodStart.getTime() === view.periodStart.getTime() &&
          row.periodEnd.getTime() === view.periodEnd.getTime(),
      );
      return match ? [{ view, watch: match }] : [];
    });
    const count = paired.reduce((sum, pair) => sum + Number(pair.view.value), 0);
    if (count <= 0) return [];
    return [
      {
        videoId: post.platformPostId,
        formatKey: idea.formatKey,
        factors: idea.factors,
        retention: Math.min(
          1,
          paired.reduce((sum, pair) => sum + Number(pair.watch.value) * 60, 0) /
            count /
            published.durationSeconds,
        ),
        evidenceSnapshotIds: paired.flatMap((pair) => [pair.view.id, pair.watch.id]),
      },
    ];
  });
}
