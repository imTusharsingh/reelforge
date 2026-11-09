import type { AnalyticsMetricDefinition, AnalyticsMetricKey } from "@reelforge/contracts";

export const YOUTUBE_ANALYTICS_READ_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
export const YOUTUBE_ANALYTICS_SOURCE_API = "youtubeanalytics.googleapis.com/v2/reports";

export const youtubeMetricCatalog = [
  {
    platform: "YOUTUBE",
    key: "views",
    label: "Views",
    description: "Number of views for the requested channel or video report.",
    accountEligibility: "Authorized owner of the YouTube channel identified by the account.",
    requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
    granularities: ["CHANNEL", "VIDEO"],
    sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
    documentationUrl: "https://developers.google.com/youtube/analytics/metrics#views",
    availabilityNotes:
      "Daily reports can end before the requested end date while YouTube finishes reporting; omitted days are unavailable, not zero.",
    verifiedAt: "2026-11-10",
  },
  {
    platform: "YOUTUBE",
    key: "likes",
    label: "Likes",
    description: "Number of times users liked a video.",
    accountEligibility: "Authorized owner of the YouTube channel identified by the account.",
    requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
    granularities: ["CHANNEL", "VIDEO"],
    sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
    documentationUrl: "https://developers.google.com/youtube/analytics/metrics#likes",
    availabilityNotes:
      "Available for channel video reports; the API may delay recent dates and revisions are retained as new snapshots.",
    verifiedAt: "2026-11-10",
  },
  {
    platform: "YOUTUBE",
    key: "comments",
    label: "Comments",
    description: "Number of times users commented on a video.",
    accountEligibility: "Authorized owner of the YouTube channel identified by the account.",
    requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
    granularities: ["CHANNEL", "VIDEO"],
    sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
    documentationUrl: "https://developers.google.com/youtube/analytics/metrics#comments",
    availabilityNotes:
      "Available for channel video reports; the API may delay recent dates and revisions are retained as new snapshots.",
    verifiedAt: "2026-11-10",
  },
  {
    platform: "YOUTUBE",
    key: "shares",
    label: "Shares",
    description: "Number of times users shared a video through the Share button.",
    accountEligibility: "Authorized owner of the YouTube channel identified by the account.",
    requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
    granularities: ["CHANNEL", "VIDEO"],
    sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
    documentationUrl: "https://developers.google.com/youtube/analytics/metrics#shares",
    availabilityNotes:
      "Available for channel video reports; the API may delay recent dates and revisions are retained as new snapshots.",
    verifiedAt: "2026-11-10",
  },
  {
    platform: "YOUTUBE",
    key: "estimatedMinutesWatched",
    label: "Estimated minutes watched",
    description: "Estimated number of minutes users watched videos.",
    accountEligibility: "Authorized owner of the YouTube channel identified by the account.",
    requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
    granularities: ["CHANNEL", "VIDEO"],
    sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
    documentationUrl:
      "https://developers.google.com/youtube/analytics/metrics#estimatedMinutesWatched",
    availabilityNotes:
      "Values are estimates; report coverage is limited to dates for which all requested metrics are available.",
    verifiedAt: "2026-11-10",
  },
  {
    platform: "YOUTUBE",
    key: "subscribersGained",
    label: "Subscribers gained",
    description: "Number of times users subscribed to the channel.",
    accountEligibility: "Authorized owner of the YouTube channel identified by the account.",
    requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
    granularities: ["CHANNEL"],
    sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
    documentationUrl: "https://developers.google.com/youtube/analytics/metrics#subscribersGained",
    availabilityNotes:
      "Channel-level figures include subscriptions from channel surfaces. Video-filtered reports count only subscriptions from that video's watch page.",
    verifiedAt: "2026-11-10",
  },
  {
    platform: "YOUTUBE",
    key: "subscribersLost",
    label: "Subscribers lost",
    description: "Number of times users unsubscribed from the channel.",
    accountEligibility: "Authorized owner of the YouTube channel identified by the account.",
    requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
    granularities: ["CHANNEL"],
    sourceApi: YOUTUBE_ANALYTICS_SOURCE_API,
    documentationUrl: "https://developers.google.com/youtube/analytics/metrics#subscribersLost",
    availabilityNotes:
      "Channel-level figures include unsubscribes from channel surfaces. Video-filtered reports count only unsubscribes from that video's watch page.",
    verifiedAt: "2026-11-10",
  },
] as const satisfies readonly AnalyticsMetricDefinition[];

export const youtubeMetricKeys = youtubeMetricCatalog.map(
  (metric) => metric.key,
) as readonly AnalyticsMetricKey[];

export function youtubeMetricUnit(key: AnalyticsMetricKey): "COUNT" | "MINUTES" {
  return key === "estimatedMinutesWatched" ? "MINUTES" : "COUNT";
}
