import type {
  AnalyticsGranularity,
  AnalyticsMetricKey,
  PublishedPostReference,
  YouTubeAnalyticsReport,
} from "@reelforge/contracts";
import type { AuthenticatedPlatformClient } from "@reelforge/social-providers";

export type PublishedPostQuery = Readonly<{
  workspaceId: string;
  channelId: string;
  socialAccountId: string;
  startDate: string;
  endDate: string;
}>;

export interface PublishedPostSource {
  isConfigured(): boolean;
  findPublishedPosts(query: PublishedPostQuery): Promise<readonly PublishedPostReference[]>;
}

export type YouTubeAnalyticsQuery = Readonly<{
  account: AuthenticatedPlatformClient;
  startDate: string;
  endDate: string;
  metrics: readonly AnalyticsMetricKey[];
  granularity: AnalyticsGranularity;
  videoIds: readonly string[];
}>;

export interface YouTubeAnalyticsClient {
  isConfigured(): boolean;
  query(query: YouTubeAnalyticsQuery): Promise<YouTubeAnalyticsReport>;
}

export class AnalyticsConnectorUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnalyticsConnectorUnavailableError";
  }
}

export class NotConfiguredPublishedPostSource implements PublishedPostSource {
  public isConfigured(): boolean {
    return false;
  }

  public findPublishedPosts(): Promise<readonly PublishedPostReference[]> {
    return Promise.reject(
      new AnalyticsConnectorUnavailableError("Published-post source is not configured"),
    );
  }
}

export class NotConfiguredYouTubeAnalyticsClient implements YouTubeAnalyticsClient {
  public isConfigured(): boolean {
    return false;
  }

  public query(): Promise<YouTubeAnalyticsReport> {
    return Promise.reject(
      new AnalyticsConnectorUnavailableError("YouTube Analytics client is not configured"),
    );
  }
}
