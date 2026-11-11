export type M29Role = "OWNER" | "EDITOR" | "VIEWER";
export type WorkflowState =
  | "CREATED"
  | "QUEUED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "SUCCEEDED"
  | "PAUSED"
  | "RETRY_WAIT"
  | "FAILED"
  | "CANCELED";
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
export type WorkflowEvent = Readonly<{ id: string; eventType: string; occurredAt: string }>;
export type WorkflowRun = Readonly<{
  id: string;
  state: WorkflowState;
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
export type Notification = Readonly<{
  id: string;
  eventType: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}>;
export type NotificationPreference = Readonly<{
  eventType: string;
  sourceModule: string;
  description: string;
  audience: string;
  inApp: boolean;
  email: boolean;
  isDefault: boolean;
}>;
export type UsageCurrency = Readonly<{
  currency: string;
  totalMinor: number;
  actualMinor: number;
  estimatedMinor: number;
  failedEstimatedMinor: number;
  reservedMinor: number;
  committedMinor: number;
  adjustmentNetMinor: number;
  byCategory: readonly Readonly<{ category: string; totalMinor: number }>[];
}>;
export type UsageSummary = Readonly<{
  period: "DAY" | "MONTH";
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  currencies: readonly UsageCurrency[];
  unknownCostRequests: number;
  unpricedRequests: number;
  notDispatchedRequests: number;
}>;
export type BudgetPeriod = Readonly<{
  period: "DAY" | "MONTH";
  limitMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  exhausted: boolean;
}>;
export type Budget = Readonly<{
  budgetId: string;
  scope: "WORKSPACE" | "CHANNEL";
  channelId: string | null;
  currency: string;
  timezone: string;
  periods: readonly BudgetPeriod[];
}>;
export type AuditRecord = Readonly<{
  id: string;
  action: string;
  reason: string;
  createdAt: string;
}>;
export type M29Data = Readonly<{
  runs: readonly WorkflowRun[];
  notifications: Readonly<{ items: readonly Notification[]; unreadCount: number }>;
  preferences: readonly NotificationPreference[];
  usage: UsageSummary;
  budgets: readonly Budget[];
  audit: readonly AuditRecord[];
}>;
