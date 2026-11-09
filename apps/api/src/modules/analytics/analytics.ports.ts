import type {
  AnalyticsGranularity,
  AnalyticsMetricKey,
  PublishedPostRecord,
  YouTubeAnalyticsReport,
} from "@reelforge/contracts";
import type { AuthenticatedPlatformClient } from "@reelforge/social-providers";
import type { WorkspaceContext } from "../identity/identity.types.js";

export interface PublishedPostSource {
  isConfigured(): boolean;
  listPublishedRecords(
    context: WorkspaceContext,
    after: string | null,
    limit: number,
    afterId: string | null,
  ): Promise<readonly PublishedPostRecord[]>;
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

  public listPublishedRecords(): Promise<readonly PublishedPostRecord[]> {
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
