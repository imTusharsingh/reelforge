export type M29Role = "OWNER" | "EDITOR" | "VIEWER";

export type WorkflowRun = Readonly<{
  id: string;
  state: string;
  dispatchStatus: string;
  budgetDecision: string;
  budgetReason: string | null;
  currentStepKey: string | null;
  nextAction: string | null;
  pausedReason: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  steps: readonly WorkflowStep[];
  jobs: readonly WorkflowJob[];
  events: readonly WorkflowEvent[];
}>;

export type WorkflowStep = Readonly<{
  id: string;
  stepKey: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  sideEffect: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}>;

export type WorkflowJob = Readonly<{
  id: string;
  status: string;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
}>;

export type WorkflowEvent = Readonly<{
  id: string;
  eventType: string;
  occurredAt: string;
}>;

export type Notification = Readonly<{
  id: string;
  eventType: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}>;

export type NotificationPreference = Readonly<{
  eventType: string;
  inApp: boolean;
  email: boolean;
}>;

export type UsageSummary = Readonly<{
  from: string;
  to: string;
  currency: string;
  totalMinor: number;
  actualMinor: number;
  estimatedMinor: number;
  unknownMinor: number;
  categories: readonly Readonly<{ category: string; amountMinor: number; kind: string }>[];
}>;

export type Budget = Readonly<{
  budgetId: string;
  scope: "WORKSPACE" | "CHANNEL";
  channelId: string | null;
  currency: string;
  timezone: string;
  periods: readonly Readonly<{
    period: "DAY" | "MONTH";
    limitMinor: number;
    consumedMinor: number;
    remainingMinor: number;
    exhausted: boolean;
  }>[];
}>;

export type M29Data = Readonly<{
  runs: readonly WorkflowRun[];
  notifications: Readonly<{ items: readonly Notification[]; unreadCount: number }>;
  preferences: readonly NotificationPreference[];
  usage: UsageSummary;
  budgets: readonly Budget[];
}>;
