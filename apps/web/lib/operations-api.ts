import type {
  AuditRecord,
  Budget,
  OperationsData,
  Notification,
  NotificationPreference,
  UsageSummary,
  WorkflowJob,
  WorkflowEvent,
  WorkflowRun,
  WorkflowStep,
} from "./operations-types";

export type OperationsContext = Readonly<{
  workspaceId: string;
  role: "OWNER" | "EDITOR" | "VIEWER" | "UNKNOWN";
}>;
export class OperationsApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OperationsApiError";
  }
}
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OperationsApiError(200, `Invalid ${label}`);
  return value as Record<string, unknown>;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new OperationsApiError(200, `Invalid ${label}`);
  return value;
};
const nullableString = (value: unknown, label: string): string | null => {
  if (value !== null && typeof value !== "string")
    throw new OperationsApiError(200, `Invalid ${label}`);
  return value;
};
const number = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new OperationsApiError(200, `Invalid ${label}`);
  return value;
};
const array = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new OperationsApiError(200, `Invalid ${label}`);
  return value;
};
const date = (value: unknown, label: string): string => {
  const parsed = string(value, label);
  if (Number.isNaN(Date.parse(parsed))) throw new OperationsApiError(200, `Invalid ${label}`);
  return parsed;
};
const bool = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new OperationsApiError(200, `Invalid ${label}`);
  return value;
};
const currencyCode = (value: unknown, label: string): string => {
  const code = string(value, label);
  if (!/^[A-Z]{3}$/.test(code)) throw new OperationsApiError(200, `Invalid ${label}`);
  return code;
};
function parseStep(value: unknown): WorkflowStep {
  const v = record(value, "workflow step");
  return {
    id: string(v.id, "step.id"),
    stepKey: string(v.stepKey, "step.stepKey"),
    status: string(v.status, "step.status"),
    attempts: number(v.attempts, "step.attempts"),
    maxAttempts: number(v.maxAttempts, "step.maxAttempts"),
    sideEffect: bool(v.sideEffect, "step.sideEffect"),
    errorCode: nullableString(v.errorCode, "step.errorCode"),
    errorMessage: nullableString(v.errorMessage, "step.errorMessage"),
    startedAt: v.startedAt === null ? null : date(v.startedAt, "step.startedAt"),
    completedAt: v.completedAt === null ? null : date(v.completedAt, "step.completedAt"),
  };
}
function parseJob(value: unknown): WorkflowJob {
  const v = record(value, "workflow job");
  return {
    id: string(v.id, "job.id"),
    status: string(v.status, "job.status"),
    attempt: number(v.attempt, "job.attempt"),
    errorCode: nullableString(v.errorCode, "job.errorCode"),
    errorMessage: nullableString(v.errorMessage, "job.errorMessage"),
  };
}
function parseEvent(value: unknown): WorkflowEvent {
  const v = record(value, "workflow event");
  return {
    id: string(v.id, "event.id"),
    eventType: string(v.eventType, "event.eventType"),
    occurredAt: date(v.occurredAt, "event.occurredAt"),
  };
}
export function parseRun(value: unknown): WorkflowRun {
  const v = record(value, "workflow run");
  const steps = array(v.steps, "run.steps").map(parseStep);
  const jobs = array(v.jobs, "run.jobs").map(parseJob);
  const events = array(v.events, "run.events").map(parseEvent);
  const state = string(v.state, "run.state");
  const allowed = [
    "CREATED",
    "QUEUED",
    "RUNNING",
    "WAITING_APPROVAL",
    "SUCCEEDED",
    "PAUSED",
    "RETRY_WAIT",
    "FAILED",
    "CANCELED",
  ] as const;
  if (!allowed.includes(state as (typeof allowed)[number]))
    throw new OperationsApiError(200, "Invalid run.state");
  return {
    id: string(v.id, "run.id"),
    state: state as WorkflowRun["state"],
    dispatchStatus: string(v.dispatchStatus, "run.dispatchStatus"),
    budgetDecision: string(v.budgetDecision, "run.budgetDecision"),
    budgetReason: nullableString(v.budgetReason, "run.budgetReason"),
    currentStepKey: nullableString(v.currentStepKey, "run.currentStepKey"),
    nextAction: nullableString(v.nextAction, "run.nextAction"),
    pausedReason: nullableString(v.pausedReason, "run.pausedReason"),
    lastErrorCode: nullableString(v.lastErrorCode, "run.lastErrorCode"),
    lastErrorMessage: nullableString(v.lastErrorMessage, "run.lastErrorMessage"),
    createdAt: date(v.createdAt, "run.createdAt"),
    updatedAt: date(v.updatedAt, "run.updatedAt"),
    steps,
    jobs,
    events,
  };
}
function parseNotification(value: unknown): Notification {
  const v = record(value, "notification");
  return {
    id: string(v.id, "notification.id"),
    eventType: string(v.eventType, "notification.eventType"),
    title: string(v.title, "notification.title"),
    body: string(v.body, "notification.body"),
    link: nullableString(v.link, "notification.link"),
    readAt: v.readAt === null ? null : date(v.readAt, "notification.readAt"),
    createdAt: date(v.createdAt, "notification.createdAt"),
  };
}
function parsePreference(value: unknown): NotificationPreference {
  const v = record(value, "preference");
  return {
    eventType: string(v.eventType, "preference.eventType"),
    sourceModule: string(v.sourceModule, "preference.sourceModule"),
    description: string(v.description, "preference.description"),
    audience: string(v.audience, "preference.audience"),
    inApp: bool(v.inApp, "preference.inApp"),
    email: bool(v.email, "preference.email"),
    isDefault: bool(v.isDefault, "preference.isDefault"),
  };
}
function parseBudget(value: unknown): Budget {
  const v = record(value, "budget");
  const scope = v.scope;
  if (scope !== "CHANNEL" && scope !== "WORKSPACE")
    throw new OperationsApiError(200, "Invalid budget.scope");
  const periods = array(v.periods, "budget.periods").map((item) => {
    const p = record(item, "budget period");
    const period = string(p.period, "budget period.period");
    if (period !== "DAY" && period !== "MONTH")
      throw new OperationsApiError(200, "Invalid budget period");
    return {
      period: period as "DAY" | "MONTH",
      limitMinor: number(p.limitMinor, "budget limit"),
      consumedMinor: number(p.consumedMinor, "budget consumed"),
      remainingMinor: number(p.remainingMinor, "budget remaining"),
      exhausted: bool(p.exhausted, "budget exhausted"),
    };
  });
  return {
    budgetId: string(v.budgetId, "budget.id"),
    scope,
    channelId: nullableString(v.channelId, "budget.channelId"),
    currency: currencyCode(v.currency, "budget.currency"),
    timezone: string(v.timezone, "budget.timezone"),
    version: number(v.version, "budget.version"),
    periods,
  };
}
function parseUsage(value: unknown): UsageSummary {
  const v = record(value, "usage");
  const period = v.period;
  if (period !== "DAY" && period !== "MONTH")
    throw new OperationsApiError(200, "Invalid usage.period");
  const totals = record(v.totals, "usage.totals");
  const currencies = array(totals.currencies, "usage currencies").map((item) => {
    const c = record(item, "currency");
    return {
      currency: currencyCode(c.currency, "currency.code"),
      totalMinor: number(c.totalMinor, "currency.total"),
      actualMinor: number(c.actualMinor, "currency.actual"),
      estimatedMinor: number(c.estimatedMinor, "currency.estimated"),
      failedEstimatedMinor: number(c.failedEstimatedMinor, "currency.failedEstimated"),
      reservedMinor: number(c.reservedMinor, "currency.reserved"),
      committedMinor: number(c.committedMinor, "currency.committed"),
      adjustmentNetMinor: number(c.adjustmentNetMinor, "currency.adjustment"),
      byCategory: array(c.byCategory, "currency.categories").map((category) => {
        const d = record(category, "category");
        return {
          category: string(d.category, "category.name"),
          totalMinor: number(d.totalMinor, "category.total"),
        };
      }),
    };
  });
  return {
    period,
    periodKey: string(v.periodKey, "usage.periodKey"),
    periodStart: date(v.periodStart, "usage.periodStart"),
    periodEnd: date(v.periodEnd, "usage.periodEnd"),
    timezone: string(v.timezone, "usage.timezone"),
    currencies,
    unknownCostRequests: number(totals.unknownCostRequests, "usage.unknown"),
    unpricedRequests: number(totals.unpricedRequests, "usage.unpriced"),
    notDispatchedRequests: number(totals.notDispatchedRequests, "usage.notDispatched"),
  };
}
function parseAudit(value: unknown): AuditRecord {
  const v = record(value, "audit");
  return {
    id: string(v.id, "audit.id"),
    action: string(v.action, "audit.action"),
    reason: string(v.reason, "audit.reason"),
    createdAt: date(v.createdAt, "audit.createdAt"),
  };
}
async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    const requestInit: RequestInit = {
      ...init,
      credentials: "include",
      headers: new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      }),
    };
    if (signal) requestInit.signal = signal;
    response = await fetch(`/api/v1${path}`, requestInit);
  } catch {
    throw new OperationsApiError(
      0,
      "The request could not be completed. Check your connection and try again.",
    );
  }
  if (!response.ok)
    throw new OperationsApiError(
      response.status,
      response.status === 403
        ? "You do not have permission for this action."
        : response.status === 409
          ? "The data changed. Refresh and try again."
          : `Request failed (${response.status})`,
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OperationsApiError(response.status, "The server returned an invalid response.");
  }
  return parse(body);
}
const parseRuns = (value: unknown): readonly WorkflowRun[] =>
  array(value, "workflow runs").map(parseRun);
const parseNotifications = (value: unknown): OperationsData["notifications"] => {
  const v = record(value, "notifications");
  return {
    items: array(v.items, "notifications.items").map(parseNotification),
    unreadCount: number(v.unreadCount, "notifications.unreadCount"),
  };
};
const parsePreferences = (value: unknown): readonly NotificationPreference[] =>
  array(value, "preferences").map(parsePreference);
const parseBudgets = (value: unknown): readonly Budget[] =>
  array(value, "budgets").map(parseBudget);
const parseAudits = (value: unknown): readonly AuditRecord[] =>
  array(value, "audit list").map(parseAudit);
export function loadOperationsData(
  context: OperationsContext,
  signal?: AbortSignal,
): Promise<OperationsData> {
  const base = `/workspaces/${encodeURIComponent(context.workspaceId)}`;
  return Promise.all([
    request(`${base}/orchestration/runs`, parseRuns, undefined, signal),
    request(`${base}/notifications`, parseNotifications, undefined, signal),
    request(`${base}/notifications/preferences`, parsePreferences, undefined, signal),
    request(`${base}/usage/summary`, parseUsage, undefined, signal),
    request(`${base}/usage/budgets`, parseBudgets, undefined, signal),
    request(`${base}/usage/audit`, parseAudits, undefined, signal),
  ]).then(([runs, notifications, preferences, usage, budgets, audit]) => ({
    runs,
    notifications,
    preferences,
    usage,
    budgets,
    audit,
  }));
}
export function runAction(
  context: OperationsContext,
  runId: string,
  action: "cancel" | "retry" | "resume",
  signal?: AbortSignal,
): Promise<WorkflowRun> {
  return request(
    `/workspaces/${encodeURIComponent(context.workspaceId)}/orchestration/runs/${encodeURIComponent(runId)}/${action}`,
    parseRun,
    { method: "POST" },
    signal,
  );
}
export function markNotificationRead(
  context: OperationsContext,
  id: string,
  signal?: AbortSignal,
): Promise<Notification> {
  return request(
    `/workspaces/${encodeURIComponent(context.workspaceId)}/notifications/${encodeURIComponent(id)}/read`,
    parseNotification,
    { method: "POST" },
    signal,
  );
}
export function markAllNotificationsRead(
  context: OperationsContext,
  signal?: AbortSignal,
): Promise<{ updated: number }> {
  return request(
    `/workspaces/${encodeURIComponent(context.workspaceId)}/notifications/read-all`,
    (value) => {
      const v = record(value, "read-all");
      return { updated: number(v.updated, "read-all.updated") };
    },
    { method: "POST" },
    signal,
  );
}
export function savePreferences(
  context: OperationsContext,
  preferences: readonly NotificationPreference[],
  signal?: AbortSignal,
): Promise<readonly NotificationPreference[]> {
  return request(
    `/workspaces/${encodeURIComponent(context.workspaceId)}/notifications/preferences`,
    parsePreferences,
    {
      method: "PUT",
      body: JSON.stringify({
        preferences: preferences.map(({ eventType, inApp, email }) => ({
          eventType,
          inApp,
          email,
        })),
      }),
    },
    signal,
  );
}

export function saveBudget(
  context: OperationsContext,
  input: Readonly<{
    currency: string;
    dailyLimitMinor?: number;
    monthlyLimitMinor?: number;
    timezone?: string;
    reason: string;
    expectedVersion?: number;
  }>,
  signal?: AbortSignal,
): Promise<Budget> {
  return request(
    `/workspaces/${encodeURIComponent(context.workspaceId)}/usage/budgets`,
    parseBudget,
    { method: "PUT", body: JSON.stringify(input) },
    signal,
  );
}
