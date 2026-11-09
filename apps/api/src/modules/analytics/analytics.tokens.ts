import type { PublishedPostReference } from "@reelforge/contracts";
import {
  AnalyticsConnectorUnavailableError,
  NotConfiguredPublishedPostSource,
  NotConfiguredYouTubeAnalyticsClient,
  type PublishedPostQuery,
  type PublishedPostSource,
  type YouTubeAnalyticsClient,
  type YouTubeAnalyticsQuery,
} from "./analytics.ports.js";

export const ANALYTICS_YOUTUBE_CLIENT = Symbol("ANALYTICS_YOUTUBE_CLIENT");
export const PUBLISHED_POST_SOURCE = Symbol("PUBLISHED_POST_SOURCE");

export {
  AnalyticsConnectorUnavailableError,
  NotConfiguredPublishedPostSource,
  NotConfiguredYouTubeAnalyticsClient,
};
export type {
  PublishedPostQuery,
  PublishedPostSource,
  PublishedPostReference,
  YouTubeAnalyticsClient,
  YouTubeAnalyticsQuery,
};
