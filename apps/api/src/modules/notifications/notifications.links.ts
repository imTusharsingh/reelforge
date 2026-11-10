/**
 * M17-T05 deep links. Every link is a relative app route (no host), so it is safe to render in
 * the web app and in email bodies once a public base URL is configured. The web routes are the
 * contract; the web app does not implement them yet.
 */
export const NOTIFICATION_LINK_ROUTES = {
  /** M16 workflow run (failed job, reconciliation, waiting approval, succeeded). */
  workflowRun: "/workspaces/:workspaceId/orchestration/runs/:runId",
  /** M11 quality review item. */
  reviewItem: "/workspaces/:workspaceId/reviews/:reviewRunId",
  /** M13 scheduled/published post. */
  publishedPost: "/workspaces/:workspaceId/publishing/posts/:scheduledPostId",
  /** M14/M15 analytics detail (an M15 insight report for a channel). */
  analyticsDetail:
    "/workspaces/:workspaceId/analytics/channels/:channelId/insight-reports/:reportId",
  /** M17 channel report. */
  channelReport: "/workspaces/:workspaceId/channels/:channelId/reports/:reportId",
} as const;

export type NotificationLinkKind = keyof typeof NOTIFICATION_LINK_ROUTES;

const segmentPattern = /^[A-Za-z0-9-]{1,100}$/;

export function buildNotificationLink(
  kind: NotificationLinkKind,
  params: Readonly<Record<string, string>>,
): string {
  return NOTIFICATION_LINK_ROUTES[kind].replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || !segmentPattern.test(value))
      throw new Error(`Invalid or missing link parameter ${name} for ${kind}`);
    return value;
  });
}
