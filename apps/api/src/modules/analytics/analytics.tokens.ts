export { AnalyticsConnectorUnavailableError } from "./analytics.ports.js";
export type { PublishedPostSource, YouTubeAnalyticsClient } from "./analytics.ports.js";

export const ANALYTICS_YOUTUBE_CLIENT = Symbol("ANALYTICS_YOUTUBE_CLIENT");
export const PUBLISHED_POST_SOURCE = Symbol("PUBLISHED_POST_SOURCE");
