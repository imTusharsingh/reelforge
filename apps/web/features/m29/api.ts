import type {
  Budget,
  M29Data,
  Notification,
  NotificationPreference,
  UsageSummary,
  WorkflowRun,
} from "./types";

export type M29Context = Readonly<{ workspaceId: string; role: "OWNER" | "EDITOR" | "VIEWER" }>;

export class M29ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "M29ApiError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new M29ApiError(200, `Invalid ${label} response`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (!isString(value)) throw new M29ApiError(200, `Invalid ${label}.${key}`);
  return value;
}

function parseRun(value: unknown): WorkflowRun {
  const record = requireRecord(value, "workflow run");
  const steps = record.steps;
  const jobs = record.jobs;
  const events = record.events;
  if (!isArray(steps) || !isArray(jobs) || !isArray(events))
    throw new M29ApiError(200, "Invalid workflow detail");
  return {
    id: requireString(record, "id", "run"),
    state: requireString(record, "state", "run"),
    dispatchStatus: requireString(record, "dispatchStatus", "run"),
    budgetDecision: requireString(record, "budgetDecision", "run"),
    budgetReason: isNullableString(record.budgetReason) ? record.budgetReason : null,
    currentStepKey: isNullableString(record.currentStepKey) ? record.currentStepKey : null,
    nextAction: isNullableString(record.nextAction) ? record.nextAction : null,
    pausedReason: isNullableString(record.pausedReason) ? record.pausedReason : null,
    lastErrorCode: isNullableString(record.lastErrorCode) ? record.lastErrorCode : null,
    lastErrorMessage: isNullableString(record.lastErrorMessage) ? record.lastErrorMessage : null,
    createdAt: requireString(record, "createdAt", "run"),
    updatedAt: requireString(record, "updatedAt", "run"),
    steps: steps as WorkflowRun["steps"],
    jobs: jobs as WorkflowRun["jobs"],
    events: events as WorkflowRun["events"],
  };
}

function parseNotifications(value: unknown): M29Data["notifications"] {
  const record = requireRecord(value, "notifications");
  if (!isArray(record.items) || typeof record.unreadCount !== "number")
    throw new M29ApiError(200, "Invalid notifications response");
  return { items: record.items as readonly Notification[], unreadCount: record.unreadCount };
}

async function request<T>(
  path: string,
  init?: RequestInit,
  parse?: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok)
    throw new M29ApiError(
      response.status,
      response.status === 403
        ? "You do not have permission for this action."
        : `Request failed (${response.status})`,
    );
  return parse ? parse(body) : (body as T);
}

export function loadM29Data(context: M29Context): Promise<M29Data> {
  const base = `/workspaces/${encodeURIComponent(context.workspaceId)}`;
  return Promise.all([
    request<unknown>(`${base}/orchestration/runs`, undefined, (value) => {
      if (!isArray(value)) throw new M29ApiError(200, "Invalid workflow list response");
      return value.map(parseRun);
    }),
    request(`${base}/notifications`, undefined, parseNotifications),
    request<readonly NotificationPreference[]>(`${base}/notifications/preferences`),
    request<UsageSummary>(`${base}/usage/summary`),
    request<readonly Budget[]>(`${base}/usage/budgets`),
  ]).then(([runs, notifications, preferences, usage, budgets]) => ({
    runs: runs as readonly WorkflowRun[],
    notifications,
    preferences,
    usage,
    budgets,
  }));
}

export function runAction(
  context: M29Context,
  runId: string,
  action: "cancel" | "retry" | "resume",
): Promise<WorkflowRun> {
  const base = `/workspaces/${encodeURIComponent(context.workspaceId)}/orchestration/runs/${encodeURIComponent(runId)}/${action}`;
  return request(base, { method: "POST" }, parseRun);
}

export function markNotificationRead(
  context: M29Context,
  notificationId: string,
): Promise<Notification> {
  return request(
    `/workspaces/${encodeURIComponent(context.workspaceId)}/notifications/${encodeURIComponent(notificationId)}/read`,
    { method: "POST" },
  ) as Promise<Notification>;
}

export function markAllNotificationsRead(context: M29Context): Promise<{ updated: number }> {
  return request(`/workspaces/${encodeURIComponent(context.workspaceId)}/notifications/read-all`, {
    method: "POST",
  });
}
