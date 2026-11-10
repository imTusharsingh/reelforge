import type { NotificationLinkKind } from "./notifications.links.js";

export type NotificationAudience = "ALL_MEMBERS" | "EDITORS";
export type NotificationSeverity = "INFO" | "WARNING" | "ACTION_REQUIRED";

export type NotificationCatalogEntry = Readonly<{
  sourceModule: "M11" | "M13" | "M15" | "M16" | "M17";
  description: string;
  audience: NotificationAudience;
  severity: NotificationSeverity;
  linkKind: NotificationLinkKind;
  defaults: Readonly<{ inApp: boolean; email: boolean }>;
  title: (payload: Readonly<Record<string, unknown>>) => string;
  body: (payload: Readonly<Record<string, unknown>>) => string;
}>;

function text(payload: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : fallback;
}

/**
 * M17-T01 notification event catalog. The key is the stable event type stored on events,
 * notifications, deliveries, and preferences. Adding a type is additive; renaming or removing one
 * is a breaking change for stored preferences.
 */
export const NOTIFICATION_EVENT_CATALOG = {
  REVIEW_NEEDED: {
    sourceModule: "M11",
    description: "A rendered video needs a human quality review decision.",
    audience: "EDITORS",
    severity: "ACTION_REQUIRED",
    linkKind: "reviewItem",
    defaults: { inApp: true, email: true },
    title: () => "Review needed",
    body: (p) =>
      `A video is waiting for your review (${text(p, "reviewStatus", "REVIEW_REQUIRED")}).`,
  },
  REVIEW_APPROVED: {
    sourceModule: "M11",
    description: "A quality review was approved.",
    audience: "ALL_MEMBERS",
    severity: "INFO",
    linkKind: "reviewItem",
    defaults: { inApp: true, email: false },
    title: () => "Review approved",
    body: () => "A video review was approved.",
  },
  REVIEW_REJECTED: {
    sourceModule: "M11",
    description: "A quality review was rejected or changes were requested.",
    audience: "ALL_MEMBERS",
    severity: "WARNING",
    linkKind: "reviewItem",
    defaults: { inApp: true, email: false },
    title: () => "Review rejected",
    body: (p) => `A video review ended with ${text(p, "action", "REJECT")}.`,
  },
  PUBLISH_SUCCEEDED: {
    sourceModule: "M13",
    description: "A post was verified as published on the platform.",
    audience: "ALL_MEMBERS",
    severity: "INFO",
    linkKind: "publishedPost",
    defaults: { inApp: true, email: false },
    title: () => "Post published",
    body: (p) => `A post was published on ${text(p, "platform", "the platform")}.`,
  },
  PUBLISH_FAILED: {
    sourceModule: "M13",
    description: "Publishing a post failed.",
    audience: "ALL_MEMBERS",
    severity: "WARNING",
    linkKind: "publishedPost",
    defaults: { inApp: true, email: true },
    title: () => "Publish failed",
    body: (p) => `Publishing failed (${text(p, "failureCode", "unknown reason")}).`,
  },
  PUBLISH_RECONCILIATION_REQUIRED: {
    sourceModule: "M13",
    description: "A publish attempt has an unknown outcome and needs manual reconciliation.",
    audience: "EDITORS",
    severity: "ACTION_REQUIRED",
    linkKind: "publishedPost",
    defaults: { inApp: true, email: true },
    title: () => "Publish needs reconciliation",
    body: (p) =>
      `A publish to ${text(p, "platform", "the platform")} needs manual reconciliation before it can be retried.`,
  },
  RUN_FAILED: {
    sourceModule: "M16",
    description: "A workflow run failed.",
    audience: "ALL_MEMBERS",
    severity: "WARNING",
    linkKind: "workflowRun",
    defaults: { inApp: true, email: true },
    title: () => "Workflow run failed",
    body: (p) =>
      `Step ${text(p, "stepKey", "unknown")} failed (${text(p, "code", "unknown error")}).`,
  },
  RUN_RECONCILIATION_REQUIRED: {
    sourceModule: "M16",
    description: "A workflow step has an unknown side-effect outcome and needs reconciliation.",
    audience: "EDITORS",
    severity: "ACTION_REQUIRED",
    linkKind: "workflowRun",
    defaults: { inApp: true, email: true },
    title: () => "Workflow run needs reconciliation",
    body: (p) =>
      `Step ${text(p, "stepKey", "unknown")} needs manual reconciliation (${text(p, "code", "unknown")}).`,
  },
  RUN_WAITING_APPROVAL: {
    sourceModule: "M16",
    description: "A workflow run is waiting for a human approval.",
    audience: "EDITORS",
    severity: "ACTION_REQUIRED",
    linkKind: "workflowRun",
    defaults: { inApp: true, email: false },
    title: () => "Workflow run waiting for approval",
    body: (p) => `Step ${text(p, "stepKey", "unknown")} is waiting for approval.`,
  },
  RUN_SUCCEEDED: {
    sourceModule: "M16",
    description: "A workflow run completed successfully.",
    audience: "ALL_MEMBERS",
    severity: "INFO",
    linkKind: "workflowRun",
    defaults: { inApp: true, email: false },
    title: () => "Workflow run succeeded",
    body: () => "A workflow run completed successfully.",
  },
  ANALYTICS_REPORT_READY: {
    sourceModule: "M15",
    description: "A performance insight report (from M14 metrics) is ready.",
    audience: "ALL_MEMBERS",
    severity: "INFO",
    linkKind: "analyticsDetail",
    defaults: { inApp: true, email: false },
    title: () => "Analytics report ready",
    body: (p) => `A performance insight report is ready (${text(p, "status", "GENERATED")}).`,
  },
  CHANNEL_REPORT_READY: {
    sourceModule: "M17",
    description: "A daily or weekly channel report is ready.",
    audience: "ALL_MEMBERS",
    severity: "INFO",
    linkKind: "channelReport",
    defaults: { inApp: true, email: false },
    title: (p) => `${text(p, "periodType", "Channel")} channel report ready`,
    body: (p) =>
      `The ${text(p, "periodType", "").toLowerCase()} report for ${text(p, "localStartDate", "the period")} is ready.`,
  },
} as const satisfies Record<string, NotificationCatalogEntry>;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENT_CATALOG;

export const NOTIFICATION_EVENT_TYPES = Object.keys(
  NOTIFICATION_EVENT_CATALOG,
) as NotificationEventType[];

export function isNotificationEventType(value: string): value is NotificationEventType {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENT_CATALOG, value);
}

export function catalogEntry(eventType: string): NotificationCatalogEntry {
  if (!isNotificationEventType(eventType))
    throw new Error(`Unknown notification event type ${eventType}`);
  return NOTIFICATION_EVENT_CATALOG[eventType];
}

export function audienceIncludes(
  audience: NotificationAudience,
  role: "OWNER" | "EDITOR" | "VIEWER",
): boolean {
  return audience === "ALL_MEMBERS" || role === "OWNER" || role === "EDITOR";
}
