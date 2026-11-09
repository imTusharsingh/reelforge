import { Injectable } from "@nestjs/common";
import { YouTubeAnalyticsReportSchema, type YouTubeAnalyticsReport } from "@reelforge/contracts";
import type { YouTubeAnalyticsClient, YouTubeAnalyticsQuery } from "./analytics.ports.js";

@Injectable()
export class M12YouTubeAnalyticsClient implements YouTubeAnalyticsClient {
  public isConfigured(): boolean {
    return (
      process.env.YOUTUBE_OAUTH_CLIENT_ID !== undefined &&
      process.env.YOUTUBE_OAUTH_CLIENT_ID.length > 0 &&
      process.env.YOUTUBE_OAUTH_CLIENT_SECRET !== undefined &&
      process.env.YOUTUBE_OAUTH_CLIENT_SECRET.length > 0
    );
  }

  public async query(query: YouTubeAnalyticsQuery): Promise<YouTubeAnalyticsReport> {
    const dimensions = query.granularity === "CHANNEL" ? ["day"] : ["day", "video"];
    const filters =
      query.granularity === "VIDEO" && query.videoIds.length > 0
        ? [`video==${query.videoIds.join(",")}`]
        : undefined;
    const report = await query.account.queryAnalytics({
      startDate: query.startDate,
      endDate: query.endDate,
      metrics: query.metrics,
      dimensions,
      ...(filters === undefined ? {} : { filters }),
    });
    return YouTubeAnalyticsReportSchema.parse(report);
  }
}
