import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import {
  categorize,
  classifyCost,
  readLedgerRows,
  type LedgerReader,
  type LedgerRow,
} from "./usage-budget.ledger.js";
import { minorToNumber } from "./usage-budget.money.js";
import {
  isValidTimeZone,
  periodBounds,
  periodForLocalDate,
  type PeriodBounds,
} from "./usage-budget.time.js";
import { UsageTotals, type UsageTotalsView } from "./usage-budget.totals.js";
import {
  BudgetExhaustedError,
  BudgetUnresolvableError,
  CATEGORIES_WITHOUT_LEDGER_SOURCE,
  DEFAULT_RESERVATION_TTL_MS,
  USAGE_CLOCK,
  type BudgetPeriodStatus,
  type BudgetStatusView,
  type ReservationView,
  type ReserveResult,
  type UsageCategoryValue,
  type UsagePeriod,
} from "./usage-budget.types.js";
import {
  parseActualMinor,
  parseAdjustment,
  parseReserve,
  parseUpsertBudget,
  parseUsageQuery,
} from "./usage-budget.validation.js";

type Tx = Prisma.TransactionClient;
type Client = Database | Tx;

type BudgetRecord = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string | null;
  scopeKey: string;
  currency: string;
  dailyLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  timezone: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

type ReservationRecord = Readonly<{
  id: string;
  workspaceId: string;
  channelId: string | null;
  idempotencyKey: string;
  category: UsageCategoryValue;
  currency: string;
  amountMinor: bigint;
  committedMinor: bigint | null;
  status: "RESERVED" | "COMMITTED" | "RELEASED" | "EXPIRED";
  correlationId: string | null;
  workflowRunId: string | null;
  scriptId: string | null;
  expiresAt: Date;
  committedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  createdAt: Date;
}>;

export type PolicyEvaluation = Readonly<{
  decision: "ALLOWED" | "BLOCKED" | "NOT_CONFIGURED";
  reason: string | null;
  budgets: BudgetStatusView[];
}>;

export type UsageSummaryView = Readonly<{
  workspaceId: string;
  channelId: string | null;
  period: UsagePeriod;
  periodKey: string;
  timezone: string;
  periodStart: string;
  periodEnd: string;
  totals: UsageTotalsView;
  categoriesWithoutLedgerSource: readonly UsageCategoryValue[];
  budgets: BudgetStatusView[];
}>;

export type ChannelUsageView = Readonly<{
  workspaceId: string;
  period: UsagePeriod;
  periodKey: string;
  timezone: string;
  periodStart: string;
  periodEnd: string;
  channels: Array<
    Readonly<{
      channelId: string | null;
      name: string | null;
      totals: UsageTotalsView;
      budget: BudgetStatusView | null;
    }>
  >;
}>;

export type CostLineView = Readonly<{
  source: "LEDGER";
  providerRequestId: string;
  correlationId: string;
  category: UsageCategoryValue;
  providerId: string;
  capabilityId: string;
  costKind: "ACTUAL" | "ESTIMATED" | "UNKNOWN";
  amountMinor: number | null;
  currency: string | null;
  workflowRunId: string | null;
  sceneMediaJobId: string | null;
  createdAt: string;
}>;

export type CostBreakdownView = Readonly<{
  workspaceId: string;
  scriptId: string | null;
  workflowRunId: string | null;
  channelId: string | null;
  totals: UsageTotalsView;
  lines: CostLineView[];
  reservations: ReservationView[];
  workflowRunIds: string[];
  renderJobs: Array<
    Readonly<{ renderJobId: string; status: string; category: "RENDER"; costKind: "NOT_TRACKED" }>
  >;
  budgets: BudgetStatusView[];
}>;

export type AuditRecordView = Readonly<{
  id: string;
  action: string;
  actorUserId: string;
  reason: string;
  before: unknown;
  after: unknown;
  correlationId: string;
  budgetId: string | null;
  adjustmentId: string | null;
  createdAt: string;
}>;

const WORKSPACE_SCOPE = "WORKSPACE";

function isUniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002")
  );
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toBigIntOrNull(value: number | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

@Injectable()
export class UsageBudgetService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(USAGE_CLOCK) private readonly clock: () => Date,
  ) {}

  // ---------------------------------------------------------------- budgets (T02) and admin (T05)

  public async listBudgets(context: WorkspaceContext): Promise<BudgetStatusView[]> {
    const budgets = await this.db.usageBudget.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const now = this.clock();
    return this.statuses(this.db, budgets, now);
  }

  /** OWNER only: create a budget or change its limits; writes one append-only audit record. */
  public async upsertBudget(context: WorkspaceContext, body: unknown): Promise<BudgetStatusView> {
    this.requireOwner(context);
    const input = parseUpsertBudget(body);
    const channelId = input.channelId ?? null;
    const channel =
      channelId === null ? null : await this.channel(this.db, context.workspaceId, channelId);
    const scopeKey = channelId ?? WORKSPACE_SCOPE;
    const correlationId = randomUUID();
    const now = this.clock();
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.usageBudget.findUnique({
          where: { workspaceId_scopeKey: { workspaceId: context.workspaceId, scopeKey } },
        });
        const timezone = channel?.timezone ?? input.timezone ?? existing?.timezone ?? "UTC";
        if (!isValidTimeZone(timezone))
          throw new BudgetUnresolvableError(
            "BUDGET_TIMEZONE_INVALID",
            `Invalid timezone ${timezone}`,
          );
        const limits = {
          dailyLimitMinor: toBigIntOrNull(input.dailyLimitMinor),
          monthlyLimitMinor: toBigIntOrNull(input.monthlyLimitMinor),
        };
        let budget: BudgetRecord;
        let before: Prisma.InputJsonValue | null = null;
        if (existing) {
          if (existing.currency !== input.currency)
            throw new ConflictException({
              code: "BUDGET_CURRENCY_IMMUTABLE",
              message: "A budget's currency cannot change; usage history is in that currency",
            });
          if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version)
            throw new ConflictException({
              code: "BUDGET_VERSION_CONFLICT",
              message: "Budget changed",
            });
          before = this.budgetSnapshot(existing);
          const updated = await tx.usageBudget.updateMany({
            where: { id: existing.id, workspaceId: context.workspaceId, version: existing.version },
            data: { ...limits, timezone, version: { increment: 1 } },
          });
          if (updated.count !== 1)
            throw new ConflictException({
              code: "BUDGET_VERSION_CONFLICT",
              message: "Budget changed",
            });
          budget = await tx.usageBudget.findUniqueOrThrow({ where: { id: existing.id } });
        } else {
          budget = await tx.usageBudget.create({
            data: {
              workspaceId: context.workspaceId,
              channelId,
              scopeKey,
              currency: input.currency,
              timezone,
              ...limits,
            },
          });
        }
        await tx.usageAuditRecord.create({
          data: {
            workspaceId: context.workspaceId,
            action: existing ? "LIMIT_CHANGED" : "BUDGET_CREATED",
            actorUserId: context.userId,
            reason: input.reason,
            ...(before === null ? {} : { before }),
            after: this.budgetSnapshot(budget),
            correlationId,
            budgetId: budget.id,
            createdAt: now,
          },
        });
        return this.budgetStatus(tx, budget, now);
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException({ code: "BUDGET_VERSION_CONFLICT", message: "Budget changed" });
      throw error;
    }
  }

  /** OWNER only: a credit or debit correction. Append-only adjustment plus audit record. */
  public async createAdjustment(
    context: WorkspaceContext,
    body: unknown,
  ): Promise<{ adjustmentId: string; correlationId: string; budgets: BudgetStatusView[] }> {
    this.requireOwner(context);
    const input = parseAdjustment(body);
    const channelId = input.channelId ?? null;
    if (channelId !== null) await this.channel(this.db, context.workspaceId, channelId);
    const correlationId = randomUUID();
    const now = this.clock();
    return this.db.$transaction(async (tx) => {
      const budgets = await this.applicableBudgets(tx, context.workspaceId, channelId);
      await this.lockBudgets(tx, context.workspaceId, budgets);
      const before = await this.statuses(tx, budgets, now);
      const adjustment = await tx.usageAdjustment.create({
        data: {
          workspaceId: context.workspaceId,
          channelId,
          kind: input.kind,
          currency: input.currency,
          amountMinor: BigInt(input.amountMinor),
          reason: input.reason,
          actorUserId: context.userId,
          correlationId,
          createdAt: now,
        },
      });
      const after = await this.statuses(tx, budgets, now);
      await tx.usageAuditRecord.create({
        data: {
          workspaceId: context.workspaceId,
          action: input.kind,
          actorUserId: context.userId,
          reason: input.reason,
          before: { budgets: before } as unknown as Prisma.InputJsonValue,
          after: {
            adjustment: {
              id: adjustment.id,
              channelId,
              kind: input.kind,
              currency: input.currency,
              amountMinor: input.amountMinor,
            },
            budgets: after,
          } as unknown as Prisma.InputJsonValue,
          correlationId,
          adjustmentId: adjustment.id,
          createdAt: now,
        },
      });
      return { adjustmentId: adjustment.id, correlationId, budgets: after };
    });
  }

  public async listAudit(context: WorkspaceContext): Promise<AuditRecordView[]> {
    const records = await this.db.usageAuditRecord.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 200,
    });
    return records.map((record) => ({
      id: record.id,
      action: record.action,
      actorUserId: record.actorUserId,
      reason: record.reason,
      before: record.before,
      after: record.after,
      correlationId: record.correlationId,
      budgetId: record.budgetId,
      adjustmentId: record.adjustmentId,
      createdAt: record.createdAt.toISOString(),
    }));
  }

  // ------------------------------------------------- preflight reservations (T02) and hard stop (T03)

  /**
   * Preflight reservation for a paid call. Locks every applicable budget row (workspace, then
   * channel, in id order) so concurrent reservations serialize and can never jointly exceed a
   * limit. Idempotent per (workspaceId, idempotencyKey). Throws BudgetExhaustedError (hard stop)
   * and returns NOT_CONFIGURED (BUDGET_POLICY_UNAVAILABLE) when no budget applies.
   */
  public async reserve(workspaceId: string, body: unknown): Promise<ReserveResult> {
    const input = parseReserve(body);
    const channelId = input.channelId ?? null;
    if (channelId !== null) await this.channel(this.db, workspaceId, channelId);
    const existing = await this.findReservationByKey(this.db, workspaceId, input.idempotencyKey);
    if (existing) return this.replay(existing, input);
    const now = this.clock();
    try {
      return await this.db.$transaction(async (tx) => {
        const candidates = await this.applicableBudgets(tx, workspaceId, channelId);
        if (candidates.length === 0)
          return { decision: "NOT_CONFIGURED", reason: "BUDGET_POLICY_UNAVAILABLE" } as const;
        await this.lockBudgets(tx, workspaceId, candidates);
        const raced = await this.findReservationByKey(tx, workspaceId, input.idempotencyKey);
        if (raced) return this.replay(raced, input);
        await this.expireReservations(tx, now, workspaceId);
        // Re-read under the lock: a concurrent limit change must be seen.
        const budgets = await this.applicableBudgets(tx, workspaceId, channelId);
        for (const budget of budgets) {
          if (budget.currency !== input.currency)
            throw new BudgetUnresolvableError(
              "BUDGET_CURRENCY_MISMATCH",
              `Reservation currency ${input.currency} does not match budget currency ${budget.currency}`,
            );
          const status = await this.budgetStatus(tx, budget, now);
          if (status.unconvertedLedgerRows > 0)
            throw new BudgetUnresolvableError(
              "BUDGET_CURRENCY_MISMATCH",
              "Spend in another currency exists in this budget's scope; it cannot be compared without FX",
            );
          for (const period of status.periods)
            if (period.consumedMinor + input.amountMinor > period.limitMinor)
              throw new BudgetExhaustedError({
                budgetId: budget.id,
                period: period.period,
                limitMinor: period.limitMinor,
                consumedMinor: period.consumedMinor,
                requestedMinor: input.amountMinor,
                currency: budget.currency,
              });
        }
        const created = await tx.usageReservation.create({
          data: {
            workspaceId,
            channelId,
            idempotencyKey: input.idempotencyKey,
            category: input.category,
            currency: input.currency,
            amountMinor: BigInt(input.amountMinor),
            correlationId: input.correlationId ?? null,
            workflowRunId: input.workflowRunId ?? null,
            scriptId: input.scriptId ?? null,
            expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS)),
            createdAt: now,
          },
        });
        const after = await this.statuses(tx, budgets, now);
        return {
          decision: "RESERVED",
          reservation: this.reservationView(created as ReservationRecord),
          budgets: after,
        } as const;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findReservationByKey(this.db, workspaceId, input.idempotencyKey);
      if (!winner) throw error;
      return this.replay(winner, input);
    }
  }

  /** Commits the actual amount. Allowed from RESERVED or EXPIRED: real spend is never hidden. */
  public async commit(
    workspaceId: string,
    reservationId: string,
    actualMinorInput: unknown,
  ): Promise<ReservationView> {
    const actualMinor = parseActualMinor(actualMinorInput);
    const now = this.clock();
    return this.db.$transaction(async (tx) => {
      const reservation = await this.lockReservation(tx, workspaceId, reservationId);
      if (reservation.status === "COMMITTED") {
        if (reservation.committedMinor === BigInt(actualMinor))
          return this.reservationView(reservation);
        throw new ConflictException({
          code: "RESERVATION_ALREADY_COMMITTED",
          message: "Reservation was already committed with a different amount",
        });
      }
      if (reservation.status === "RELEASED")
        throw new ConflictException({
          code: "RESERVATION_RELEASED",
          message: "A released reservation cannot be committed",
        });
      const updated = await tx.usageReservation.update({
        where: { id: reservation.id },
        data: { status: "COMMITTED", committedMinor: BigInt(actualMinor), committedAt: now },
      });
      return this.reservationView(updated as ReservationRecord);
    });
  }

  /** Releases an unused reservation. Idempotent; a committed reservation cannot be released. */
  public async release(
    workspaceId: string,
    reservationId: string,
    reason = "RELEASED_BY_CALLER",
  ): Promise<ReservationView> {
    const now = this.clock();
    return this.db.$transaction(async (tx) => {
      const reservation = await this.lockReservation(tx, workspaceId, reservationId);
      if (reservation.status === "RELEASED" || reservation.status === "EXPIRED")
        return this.reservationView(reservation);
      if (reservation.status === "COMMITTED")
        throw new ConflictException({
          code: "RESERVATION_ALREADY_COMMITTED",
          message: "A committed reservation cannot be released",
        });
      const updated = await tx.usageReservation.update({
        where: { id: reservation.id },
        data: { status: "RELEASED", releasedAt: now, releaseReason: reason.slice(0, 200) },
      });
      return this.reservationView(updated as ReservationRecord);
    });
  }

  /**
   * Expiry sweep: RESERVED reservations past expiresAt become EXPIRED. Expired reservations
   * already stop counting at their expiry instant, so a late sweep never over-blocks.
   */
  public async sweepExpiredReservations(
    now: Date = this.clock(),
    workspaceId?: string,
  ): Promise<number> {
    return this.expireReservations(this.db, now, workspaceId);
  }

  // --------------------------------------------------------------------- policy adapter (T03 / M16)

  public async evaluatePolicy(
    workspaceId: string,
    channelId: string | null,
  ): Promise<PolicyEvaluation> {
    const budgets = await this.applicableBudgets(this.db, workspaceId, channelId);
    if (budgets.length === 0)
      return { decision: "NOT_CONFIGURED", reason: "BUDGET_POLICY_UNAVAILABLE", budgets: [] };
    const now = this.clock();
    const statuses: BudgetStatusView[] = [];
    for (const budget of budgets) {
      let status: BudgetStatusView;
      try {
        status = await this.budgetStatus(this.db, budget, now);
      } catch (error) {
        if (error instanceof BudgetUnresolvableError)
          return { decision: "BLOCKED", reason: error.code, budgets: statuses };
        throw error;
      }
      statuses.push(status);
      if (status.unconvertedLedgerRows > 0)
        return { decision: "BLOCKED", reason: "BUDGET_CURRENCY_MISMATCH", budgets: statuses };
      if (status.periods.some((period) => period.exhausted))
        return { decision: "BLOCKED", reason: "BUDGET_EXHAUSTED", budgets: statuses };
    }
    return { decision: "ALLOWED", reason: null, budgets: statuses };
  }

  // -------------------------------------------------------------------------- dashboard views (T04)

  public async usageSummary(
    context: WorkspaceContext,
    rawQuery: unknown,
  ): Promise<UsageSummaryView> {
    const query = parseUsageQuery(rawQuery);
    const channelId = query.channelId ?? null;
    const channel =
      channelId === null ? null : await this.channel(this.db, context.workspaceId, channelId);
    const now = this.clock();
    const timezone =
      query.timezone ?? channel?.timezone ?? (await this.workspaceTimezone(context.workspaceId));
    const bounds = this.bounds(query, timezone, now);
    const totals = new UsageTotals(now);
    for (const row of await this.ledger(this.db, {
      workspaceId: context.workspaceId,
      now,
      channelId,
      from: bounds.start,
      to: bounds.end,
    }))
      totals.addLedger(row);
    const scope = {
      workspaceId: context.workspaceId,
      createdAt: { gte: bounds.start, lt: bounds.end },
      ...(channelId === null ? {} : { channelId }),
    };
    for (const reservation of await this.db.usageReservation.findMany({ where: scope }))
      totals.addReservation(reservation);
    for (const adjustment of await this.db.usageAdjustment.findMany({ where: scope }))
      totals.addAdjustment(adjustment);
    const budgets = await this.applicableBudgets(this.db, context.workspaceId, channelId);
    return {
      workspaceId: context.workspaceId,
      channelId,
      period: bounds.period,
      periodKey: bounds.key,
      timezone,
      periodStart: bounds.start.toISOString(),
      periodEnd: bounds.end.toISOString(),
      totals: totals.view(),
      categoriesWithoutLedgerSource: CATEGORIES_WITHOUT_LEDGER_SOURCE,
      budgets: await this.statuses(this.db, budgets, now),
    };
  }

  public async channelUsage(
    context: WorkspaceContext,
    rawQuery: unknown,
  ): Promise<ChannelUsageView> {
    const query = parseUsageQuery(rawQuery);
    if (query.channelId !== undefined)
      throw new BadRequestException("Use the summary endpoint for a single channel");
    const now = this.clock();
    const timezone = query.timezone ?? (await this.workspaceTimezone(context.workspaceId));
    const bounds = this.bounds(query, timezone, now);
    const channels = await this.db.channel.findMany({
      where: { workspaceId: context.workspaceId },
      select: { id: true, name: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const byChannel = new Map<string | null, UsageTotals>();
    const totalsFor = (id: string | null): UsageTotals => {
      let found = byChannel.get(id);
      if (!found) {
        found = new UsageTotals(now);
        byChannel.set(id, found);
      }
      return found;
    };
    for (const channel of channels) totalsFor(channel.id);
    for (const row of await this.ledger(this.db, {
      workspaceId: context.workspaceId,
      now,
      from: bounds.start,
      to: bounds.end,
    }))
      totalsFor(row.channelId).addLedger(row);
    const scope = {
      workspaceId: context.workspaceId,
      createdAt: { gte: bounds.start, lt: bounds.end },
    };
    for (const reservation of await this.db.usageReservation.findMany({ where: scope }))
      totalsFor(reservation.channelId).addReservation(reservation);
    for (const adjustment of await this.db.usageAdjustment.findMany({ where: scope }))
      totalsFor(adjustment.channelId).addAdjustment(adjustment);
    const budgets = await this.db.usageBudget.findMany({
      where: { workspaceId: context.workspaceId, channelId: { not: null } },
    });
    const names = new Map(channels.map((channel) => [channel.id, channel.name]));
    const result: Array<ChannelUsageView["channels"][number]> = [];
    for (const [id, totals] of byChannel) {
      const budget = budgets.find((item) => item.channelId === id);
      result.push({
        channelId: id,
        name: id === null ? null : (names.get(id) ?? null),
        totals: totals.view(),
        budget: budget ? await this.budgetStatus(this.db, budget, now) : null,
      });
    }
    return {
      workspaceId: context.workspaceId,
      period: bounds.period,
      periodKey: bounds.key,
      timezone,
      periodStart: bounds.start.toISOString(),
      periodEnd: bounds.end.toISOString(),
      channels: result,
    };
  }

  /** Per-video cost breakdown. The script id is the video key (see the ledger join notes). */
  public async videoBreakdown(
    context: WorkspaceContext,
    scriptId: string,
  ): Promise<CostBreakdownView> {
    const script = await this.db.script.findFirst({
      where: { workspaceId: context.workspaceId, id: scriptId },
      select: { id: true, channelId: true },
    });
    if (!script) throw new NotFoundException("Script not found");
    const now = this.clock();
    const rows = await this.ledger(this.db, { workspaceId: context.workspaceId, now, scriptId });
    const reservations = await this.db.usageReservation.findMany({
      where: { workspaceId: context.workspaceId, scriptId },
      orderBy: { createdAt: "asc" },
    });
    const renderJobs = await this.db.renderJob.findMany({
      where: { workspaceId: context.workspaceId, sceneMediaJob: { scriptId } },
      select: { id: true, status: true },
      orderBy: { createdAt: "asc" },
    });
    return this.breakdown(context.workspaceId, now, {
      scriptId,
      workflowRunId: null,
      channelId: script.channelId,
      rows,
      reservations: reservations as ReservationRecord[],
      renderJobs,
    });
  }

  /** Per-job (M16 workflow run) cost breakdown. */
  public async runBreakdown(context: WorkspaceContext, runId: string): Promise<CostBreakdownView> {
    const run = await this.db.workflowRun.findFirst({
      where: { workspaceId: context.workspaceId, id: runId },
      select: { id: true, channelId: true },
    });
    if (!run) throw new NotFoundException("Workflow run not found");
    const now = this.clock();
    const rows = await this.ledger(this.db, {
      workspaceId: context.workspaceId,
      now,
      workflowRunId: runId,
    });
    const reservations = await this.db.usageReservation.findMany({
      where: { workspaceId: context.workspaceId, workflowRunId: runId },
      orderBy: { createdAt: "asc" },
    });
    return this.breakdown(context.workspaceId, now, {
      scriptId: null,
      workflowRunId: runId,
      channelId: run.channelId,
      rows,
      reservations: reservations as ReservationRecord[],
      renderJobs: [],
    });
  }

  // ------------------------------------------------------------------------------------ internals

  private async breakdown(
    workspaceId: string,
    now: Date,
    input: Readonly<{
      scriptId: string | null;
      workflowRunId: string | null;
      channelId: string | null;
      rows: LedgerRow[];
      reservations: ReservationRecord[];
      renderJobs: Array<{ id: string; status: string }>;
    }>,
  ): Promise<CostBreakdownView> {
    const totals = new UsageTotals(now);
    const runIds = new Set<string>();
    const lines = input.rows.map((row): CostLineView => {
      totals.addLedger(row);
      if (row.workflowRunId !== null) runIds.add(row.workflowRunId);
      const cost = classifyCost(row);
      return {
        source: "LEDGER",
        providerRequestId: row.id,
        correlationId: row.correlationId,
        category: categorize(row),
        providerId: row.providerId,
        capabilityId: row.capabilityId,
        costKind: cost.kind,
        amountMinor: cost.amountMinor === null ? null : minorToNumber(cost.amountMinor),
        currency: cost.currency,
        workflowRunId: row.workflowRunId,
        sceneMediaJobId: row.sceneMediaJobId,
        createdAt: row.createdAt.toISOString(),
      };
    });
    for (const reservation of input.reservations) {
      totals.addReservation(reservation);
      if (reservation.workflowRunId !== null) runIds.add(reservation.workflowRunId);
    }
    if (input.workflowRunId !== null) runIds.add(input.workflowRunId);
    const budgets = await this.applicableBudgets(this.db, workspaceId, input.channelId);
    return {
      workspaceId,
      scriptId: input.scriptId,
      workflowRunId: input.workflowRunId,
      channelId: input.channelId,
      totals: totals.view(),
      lines,
      reservations: input.reservations.map((reservation) => this.reservationView(reservation)),
      workflowRunIds: [...runIds].sort(),
      renderJobs: input.renderJobs.map((job) => ({
        renderJobId: job.id,
        status: job.status,
        category: "RENDER" as const,
        costKind: "NOT_TRACKED" as const,
      })),
      budgets: await this.statuses(this.db, budgets, now),
    };
  }

  private ledger(db: Client, filter: Parameters<typeof readLedgerRows>[1]): Promise<LedgerRow[]> {
    return readLedgerRows(db as unknown as LedgerReader, filter);
  }

  private bounds(
    query: Readonly<{ period: UsagePeriod; date?: string | undefined }>,
    timezone: string,
    now: Date,
  ): PeriodBounds {
    return query.date === undefined
      ? periodBounds(now, query.period, timezone)
      : periodForLocalDate(query.date, query.period, timezone);
  }

  private async workspaceTimezone(workspaceId: string): Promise<string> {
    const budget = await this.db.usageBudget.findUnique({
      where: { workspaceId_scopeKey: { workspaceId, scopeKey: WORKSPACE_SCOPE } },
      select: { timezone: true },
    });
    return budget?.timezone ?? "UTC";
  }

  private async channel(
    db: Client,
    workspaceId: string,
    channelId: string,
  ): Promise<{ id: string; timezone: string }> {
    const channel = await db.channel.findFirst({
      where: { workspaceId, id: channelId },
      select: { id: true, timezone: true },
    });
    if (!channel) throw new NotFoundException("Channel not found");
    return channel;
  }

  /** Workspace budget plus the channel budget (if any), ordered by id for deterministic locking. */
  private async applicableBudgets(
    db: Client,
    workspaceId: string,
    channelId: string | null,
  ): Promise<BudgetRecord[]> {
    const scopeKeys = channelId === null ? [WORKSPACE_SCOPE] : [WORKSPACE_SCOPE, channelId];
    return db.usageBudget.findMany({
      where: { workspaceId, scopeKey: { in: scopeKeys } },
      orderBy: { id: "asc" },
    });
  }

  private async lockBudgets(
    tx: Tx,
    workspaceId: string,
    budgets: readonly BudgetRecord[],
  ): Promise<void> {
    if (budgets.length === 0) return;
    const ids = budgets.map((budget) => budget.id).sort();
    await tx.$queryRaw`
      SELECT "id" FROM "usage_budgets"
      WHERE "workspace_id" = ${workspaceId}::uuid AND "id" = ANY(${ids}::uuid[])
      ORDER BY "id"
      FOR UPDATE`;
  }

  private async lockReservation(
    tx: Tx,
    workspaceId: string,
    id: string,
  ): Promise<ReservationRecord> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"::text AS "id" FROM "usage_reservations"
      WHERE "workspace_id" = ${workspaceId}::uuid AND "id" = ${id}::uuid
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException("Reservation not found");
    return (await tx.usageReservation.findUniqueOrThrow({ where: { id } })) as ReservationRecord;
  }

  private async expireReservations(db: Client, now: Date, workspaceId?: string): Promise<number> {
    const result = await db.usageReservation.updateMany({
      where: {
        status: "RESERVED",
        expiresAt: { lte: now },
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
      data: { status: "EXPIRED", releasedAt: now, releaseReason: "EXPIRED" },
    });
    return result.count;
  }

  private async findReservationByKey(
    db: Client,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<ReservationRecord | null> {
    return (await db.usageReservation.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    })) as ReservationRecord | null;
  }

  private async replay(
    existing: ReservationRecord,
    input: Readonly<{
      channelId?: string | null | undefined;
      category: UsageCategoryValue;
      currency: string;
      amountMinor: number;
    }>,
  ): Promise<ReserveResult> {
    if (
      existing.channelId !== (input.channelId ?? null) ||
      existing.category !== input.category ||
      existing.currency !== input.currency ||
      existing.amountMinor !== BigInt(input.amountMinor)
    )
      throw new ConflictException({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "The idempotency key was used for a different reservation",
      });
    const budgets = await this.applicableBudgets(this.db, existing.workspaceId, existing.channelId);
    const now = this.clock();
    return {
      decision: "RESERVED",
      reservation: this.reservationView(existing),
      budgets: await this.statuses(this.db, budgets, now),
    };
  }

  /** Sequential on purpose: queries on one transaction connection must not overlap. */
  private async statuses(
    db: Client,
    budgets: readonly BudgetRecord[],
    now: Date,
  ): Promise<BudgetStatusView[]> {
    const result: BudgetStatusView[] = [];
    for (const budget of budgets) result.push(await this.budgetStatus(db, budget, now));
    return result;
  }

  /** Budget consumption for each configured period, in the budget's (or channel's) timezone. */
  private async budgetStatus(
    db: Client,
    budget: BudgetRecord,
    now: Date,
  ): Promise<BudgetStatusView> {
    let timezone = budget.timezone;
    if (budget.channelId !== null) {
      const channel = await db.channel.findFirst({
        where: { workspaceId: budget.workspaceId, id: budget.channelId },
        select: { timezone: true },
      });
      timezone = channel?.timezone ?? timezone;
    }
    if (!isValidTimeZone(timezone))
      throw new BudgetUnresolvableError("BUDGET_TIMEZONE_INVALID", `Invalid timezone ${timezone}`);
    const periods: BudgetPeriodStatus[] = [];
    let unconverted = 0;
    const limits: Array<[UsagePeriod, bigint | null]> = [
      ["DAY", budget.dailyLimitMinor],
      ["MONTH", budget.monthlyLimitMinor],
    ];
    for (const [period, limit] of limits) {
      if (limit === null) continue;
      const bounds = periodBounds(now, period, timezone);
      const consumption = await this.consumption(db, budget, bounds, now);
      unconverted = Math.max(unconverted, consumption.unconverted);
      const remaining = limit - consumption.consumed;
      periods.push({
        period,
        periodStart: bounds.start.toISOString(),
        periodEnd: bounds.end.toISOString(),
        limitMinor: minorToNumber(limit),
        consumedMinor: minorToNumber(consumption.consumed),
        remainingMinor: minorToNumber(remaining > 0n ? remaining : 0n),
        exhausted: consumption.consumed >= limit,
      });
    }
    return {
      budgetId: budget.id,
      scope: budget.channelId === null ? "WORKSPACE" : "CHANNEL",
      channelId: budget.channelId,
      currency: budget.currency,
      timezone,
      version: budget.version,
      dailyLimitMinor:
        budget.dailyLimitMinor === null ? null : minorToNumber(budget.dailyLimitMinor),
      monthlyLimitMinor:
        budget.monthlyLimitMinor === null ? null : minorToNumber(budget.monthlyLimitMinor),
      periods,
      unconvertedLedgerRows: unconverted,
    };
  }

  /**
   * consumed = M08 ledger spend (actual, else estimate for succeeded/pending calls) not covered by
   * an M18 reservation + live reservations + committed reservations + debits - credits.
   */
  private async consumption(
    db: Client,
    budget: BudgetRecord,
    bounds: PeriodBounds,
    now: Date,
  ): Promise<{ consumed: bigint; unconverted: number }> {
    let consumed = 0n;
    let unconverted = 0;
    const rows = await this.ledger(db, {
      workspaceId: budget.workspaceId,
      now,
      channelId: budget.channelId,
      from: bounds.start,
      to: bounds.end,
    });
    for (const row of rows) {
      const cost = classifyCost(row);
      if (cost.kind === "UNKNOWN") continue;
      if (cost.currency !== budget.currency || cost.amountMinor === null) {
        unconverted += 1;
        continue;
      }
      consumed += cost.amountMinor;
    }
    const channelFilter =
      budget.channelId === null
        ? Prisma.empty
        : Prisma.sql`AND "channel_id" = ${budget.channelId}::uuid`;
    const [reservations] = await db.$queryRaw<Array<{ matched: string; other: string }>>`
      SELECT
        COALESCE(SUM(CASE WHEN "currency" = ${budget.currency} THEN "counted" END), 0)::text AS "matched",
        COUNT(*) FILTER (WHERE "currency" <> ${budget.currency} AND "counted" > 0)::text AS "other"
      FROM (
        SELECT "currency",
               CASE WHEN "status" = 'COMMITTED' THEN "committed_minor"
                    WHEN "status" = 'RESERVED' AND "expires_at" > ${now} THEN "amount_minor"
                    ELSE 0 END AS "counted"
        FROM "usage_reservations"
        WHERE "workspace_id" = ${budget.workspaceId}::uuid
          AND "created_at" >= ${bounds.start} AND "created_at" < ${bounds.end}
          ${channelFilter}
      ) counted_reservations`;
    const [adjustments] = await db.$queryRaw<Array<{ matched: string; other: string }>>`
      SELECT
        COALESCE(SUM(CASE WHEN "currency" = ${budget.currency}
                          THEN CASE WHEN "kind" = 'DEBIT' THEN "amount_minor" ELSE -"amount_minor" END
                     END), 0)::text AS "matched",
        COUNT(*) FILTER (WHERE "currency" <> ${budget.currency})::text AS "other"
      FROM "usage_adjustments"
      WHERE "workspace_id" = ${budget.workspaceId}::uuid
        AND "created_at" >= ${bounds.start} AND "created_at" < ${bounds.end}
        ${channelFilter}`;
    consumed += BigInt(reservations?.matched ?? "0") + BigInt(adjustments?.matched ?? "0");
    unconverted += Number(reservations?.other ?? "0") + Number(adjustments?.other ?? "0");
    return { consumed: consumed > 0n ? consumed : 0n, unconverted };
  }

  private reservationView(reservation: ReservationRecord): ReservationView {
    return {
      id: reservation.id,
      workspaceId: reservation.workspaceId,
      channelId: reservation.channelId,
      idempotencyKey: reservation.idempotencyKey,
      category: reservation.category,
      currency: reservation.currency,
      amountMinor: minorToNumber(reservation.amountMinor),
      committedMinor:
        reservation.committedMinor === null ? null : minorToNumber(reservation.committedMinor),
      status: reservation.status,
      correlationId: reservation.correlationId,
      workflowRunId: reservation.workflowRunId,
      scriptId: reservation.scriptId,
      expiresAt: reservation.expiresAt.toISOString(),
      committedAt: iso(reservation.committedAt),
      releasedAt: iso(reservation.releasedAt),
      releaseReason: reservation.releaseReason,
      createdAt: reservation.createdAt.toISOString(),
    };
  }

  private budgetSnapshot(budget: BudgetRecord): Prisma.InputJsonValue {
    return {
      budgetId: budget.id,
      channelId: budget.channelId,
      currency: budget.currency,
      dailyLimitMinor:
        budget.dailyLimitMinor === null ? null : minorToNumber(budget.dailyLimitMinor),
      monthlyLimitMinor:
        budget.monthlyLimitMinor === null ? null : minorToNumber(budget.monthlyLimitMinor),
      timezone: budget.timezone,
      version: budget.version,
    };
  }

  private requireOwner(context: WorkspaceContext): void {
    if (context.role !== "OWNER")
      throw new ForbiddenException("Only a workspace OWNER can change budgets or adjust usage");
  }
}
