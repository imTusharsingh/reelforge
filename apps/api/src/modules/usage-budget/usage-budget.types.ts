import { ConflictException, ServiceUnavailableException } from "@nestjs/common";

/** Usage categories (M18-T01). UNCATEGORIZED marks ledger rows whose capability is unknown. */
export const USAGE_CATEGORIES = [
  "LLM",
  "TTS",
  "IMAGE_MEDIA",
  "VIDEO_MEDIA",
  "RENDER",
  "PUBLISH",
  "ANALYTICS_API",
  "UNCATEGORIZED",
] as const;
export type UsageCategoryValue = (typeof USAGE_CATEGORIES)[number];

/**
 * Categories with no M08 ledger source today: render is local FFmpeg, and publish/analytics API
 * calls are not costed by M08. They report zero ledger spend and only show reservations or
 * adjustments that callers record explicitly.
 */
export const CATEGORIES_WITHOUT_LEDGER_SOURCE: readonly UsageCategoryValue[] = [
  "RENDER",
  "PUBLISH",
  "ANALYTICS_API",
];

export type UsagePeriod = "DAY" | "MONTH";
/**
 * ACTUAL: provider-reported cost. ESTIMATED: succeeded or in-flight call charged at its estimate.
 * FAILED_ESTIMATED: a call that failed after dispatch with no reported cost, charged at its
 * estimate ("failed, charged at estimate") because the provider may have billed it; an OWNER can
 * correct it with an audited CREDIT. NOT_DISPATCHED: provably refused before the provider was
 * called (zero). UNKNOWN: no actual cost and no estimate (zero, flagged).
 */
export type CostKind = "ACTUAL" | "ESTIMATED" | "FAILED_ESTIMATED" | "NOT_DISPATCHED" | "UNKNOWN";

export const COST_KIND_LABELS: Readonly<Record<CostKind, string>> = {
  ACTUAL: "actual",
  ESTIMATED: "estimated",
  FAILED_ESTIMATED: "failed, charged at estimate",
  NOT_DISPATCHED: "not dispatched",
  UNKNOWN: "unknown",
};

/**
 * Ledger error codes that M08 writes only when the provider was provably never called (the M18
 * preflight refused the call, or the M08 reservation failed). Such rows are never charged.
 */
export const PRE_DISPATCH_ERROR_CODES: readonly string[] = [
  "NOT_DISPATCHED",
  "BUDGET_EXHAUSTED",
  "BUDGET_CURRENCY_MISMATCH",
  "BUDGET_TIMEZONE_INVALID",
];

/** Handle for an M18 reservation held around one M08 paid provider call. */
export type PaidCallReservation = Readonly<{
  workspaceId: string;
  reservationId: string;
  currency: string;
  estimateMinor: number;
}>;

export const USAGE_CLOCK = Symbol("USAGE_CLOCK");
export const BILLING_PROVIDER = Symbol("BILLING_PROVIDER");

/** Default lifetime of a preflight reservation before the expiry sweep releases it. */
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;
export const MAX_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export type BudgetPeriodStatus = Readonly<{
  period: UsagePeriod;
  periodStart: string;
  periodEnd: string;
  limitMinor: number;
  consumedMinor: number;
  remainingMinor: number;
  exhausted: boolean;
}>;

export type BudgetStatusView = Readonly<{
  budgetId: string;
  scope: "WORKSPACE" | "CHANNEL";
  channelId: string | null;
  currency: string;
  timezone: string;
  version: number;
  dailyLimitMinor: number | null;
  monthlyLimitMinor: number | null;
  periods: BudgetPeriodStatus[];
  /** Ledger rows in another currency are not converted (no FX); they block reservations. */
  unconvertedLedgerRows: number;
}>;

export type ReservationView = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string | null;
  idempotencyKey: string;
  category: UsageCategoryValue;
  currency: string;
  amountMinor: number;
  committedMinor: number | null;
  status: "RESERVED" | "COMMITTED" | "RELEASED" | "EXPIRED";
  correlationId: string | null;
  workflowRunId: string | null;
  scriptId: string | null;
  expiresAt: string;
  committedAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  createdAt: string;
}>;

export type ReserveResult =
  | Readonly<{
      decision: "RESERVED";
      reservation: ReservationView;
      budgets: BudgetStatusView[];
      /** True when the idempotency key already existed and the stored reservation was returned. */
      replayed: boolean;
    }>
  | Readonly<{ decision: "NOT_CONFIGURED"; reason: "BUDGET_POLICY_UNAVAILABLE" }>;

/** Typed hard stop (M18-T03). Never caught and ignored inside M18. */
export class BudgetExhaustedError extends ConflictException {
  public readonly code = "BUDGET_EXHAUSTED";
  public constructor(
    public readonly details: Readonly<{
      budgetId: string;
      period: UsagePeriod;
      limitMinor: number;
      consumedMinor: number;
      requestedMinor: number;
      currency: string;
    }>,
  ) {
    super({
      code: "BUDGET_EXHAUSTED",
      message: `Budget exhausted for the ${details.period.toLowerCase()} period`,
      ...details,
    });
  }
}

/** Raised when a budget exists but spend in its scope cannot be compared safely. */
export class BudgetUnresolvableError extends ConflictException {
  public constructor(
    public readonly code: "BUDGET_CURRENCY_MISMATCH" | "BUDGET_TIMEZONE_INVALID",
    message: string,
  ) {
    super({ code, message });
  }
}

/** The M18 preflight could not run (e.g. database error): the paid call is not dispatched. */
export class PaidCallNotDispatchedError extends ServiceUnavailableException {
  public readonly code = "NOT_DISPATCHED";
  public constructor(message: string) {
    super({ code: "NOT_DISPATCHED", message });
  }
}

/** Payment collection is out of scope in v1 (M18-T06): an extension point only. */
export class BillingNotConfiguredError extends ServiceUnavailableException {
  public readonly code = "BILLING_PROVIDER_NOT_CONFIGURED";
  public constructor() {
    super({ code: "BILLING_PROVIDER_NOT_CONFIGURED", message: "No billing provider in v1" });
  }
}
