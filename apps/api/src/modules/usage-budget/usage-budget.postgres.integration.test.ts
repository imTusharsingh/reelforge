import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDatabaseClient, Prisma } from "@reelforge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelService } from "../channel/channel.service.js";
import { WorkflowLimitsService } from "../orchestration/orchestration.limits.js";
import { NotConfiguredWorkflowQueue } from "../orchestration/orchestration.queue.js";
import { OrchestrationService } from "../orchestration/orchestration.service.js";
import {
  DEFAULT_WORKFLOW_LIMIT_CONFIG,
  type WorkflowStepDispatchInput,
  type WorkflowStepDispatchResult,
} from "../orchestration/orchestration.types.js";
import { WorkspaceRepository } from "../workspace/workspace.repository.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { UsageBudgetPolicy } from "./usage-budget.policy.js";
import { UsageBudgetService } from "./usage-budget.service.js";
import { BudgetExhaustedError } from "./usage-budget.types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

type Role = "OWNER" | "EDITOR" | "VIEWER";
type Tenant = Readonly<{
  workspaceId: string;
  channelId: string;
  owner: { workspaceId: string; userId: string; role: Role };
  editor: { workspaceId: string; userId: string; role: Role };
  viewer: { workspaceId: string; userId: string; role: Role };
}>;

suite("M18 usage, budget and billing on PostgreSQL", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const secondDb = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let clockMs = Date.parse("2026-11-10T08:00:00.000Z");
  const clock = (): Date => new Date(clockMs);
  const workspaces: string[] = [];
  const users: string[] = [];

  function service(database = db): UsageBudgetService {
    if (!database) throw new Error("database unavailable");
    return new UsageBudgetService(database as never, clock);
  }

  async function tenant(timezone = "UTC", schedule: unknown = null): Promise<Tenant> {
    if (!db) throw new Error("database unavailable");
    const workspaceId = randomUUID();
    const channelId = randomUUID();
    const [ownerId, editorId, viewerId] = [randomUUID(), randomUUID(), randomUUID()];
    users.push(ownerId, editorId, viewerId);
    workspaces.push(workspaceId);
    await db.user.createMany({
      data: [ownerId, editorId, viewerId].map((id) => ({ id, email: `${id}@m18.invalid` })),
    });
    await db.workspace.create({ data: { id: workspaceId, name: "m18-integration" } });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: editorId, role: "EDITOR" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
      ],
    });
    await db.channel.create({
      data: {
        id: channelId,
        workspaceId,
        name: "m18-channel",
        timezone,
        ...(schedule === null ? {} : { schedule: schedule as Prisma.InputJsonValue }),
      },
    });
    return {
      workspaceId,
      channelId,
      owner: { workspaceId, userId: ownerId, role: "OWNER" },
      editor: { workspaceId, userId: editorId, role: "EDITOR" },
      viewer: { workspaceId, userId: viewerId, role: "VIEWER" },
    };
  }

  async function ledgerRow(
    t: Tenant,
    data: Partial<Prisma.ProviderRequestUncheckedCreateInput> = {},
  ): Promise<string> {
    if (!db) throw new Error("database unavailable");
    const correlationId = data.correlationId ?? randomUUID();
    await db.providerRequest.create({
      data: {
        workspaceId: t.workspaceId,
        channelId: t.channelId,
        correlationId,
        providerId: "fixture",
        capabilityId: "llm",
        status: "SUCCEEDED",
        currency: "USD",
        createdAt: clock(),
        ...data,
      },
    });
    return correlationId;
  }

  beforeAll(() => {
    clockMs = Date.parse("2026-11-10T08:00:00.000Z");
  });

  afterAll(async () => {
    if (!db || !secondDb) return;
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
    await secondDb.$disconnect();
  });

  it("returns NOT_CONFIGURED / BUDGET_POLICY_UNAVAILABLE when no budget exists", async () => {
    if (!db) return;
    const t = await tenant();
    const usage = service();
    await expect(
      usage.reserve(t.workspaceId, {
        idempotencyKey: "nc-1",
        category: "LLM",
        currency: "USD",
        amountMinor: 10,
      }),
    ).resolves.toEqual({ decision: "NOT_CONFIGURED", reason: "BUDGET_POLICY_UNAVAILABLE" });
    await expect(usage.evaluatePolicy(t.workspaceId, t.channelId)).resolves.toMatchObject({
      decision: "NOT_CONFIGURED",
      reason: "BUDGET_POLICY_UNAVAILABLE",
    });
    expect(await db.usageReservation.count({ where: { workspaceId: t.workspaceId } })).toBe(0);
  });

  it("lets exactly one of two concurrent reservations at the limit win", async () => {
    if (!db || !secondDb) return;
    const t = await tenant();
    await service().upsertBudget(t.owner, {
      currency: "USD",
      dailyLimitMinor: 1000,
      reason: "concurrency fixture",
    });
    const reserve = (database: typeof db, key: string): Promise<unknown> =>
      service(database).reserve(t.workspaceId, {
        channelId: t.channelId,
        idempotencyKey: key,
        category: "LLM",
        currency: "USD",
        amountMinor: 600,
      });
    const results = await Promise.allSettled([reserve(db, "race-a"), reserve(secondDb, "race-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      BudgetExhaustedError,
    );

    // A wider burst: 8 concurrent 300-minor reservations against the remaining 400 -> one wins.
    const burst = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        service(index % 2 === 0 ? db : secondDb).reserve(t.workspaceId, {
          idempotencyKey: `burst-${index}`,
          category: "IMAGE_MEDIA",
          currency: "USD",
          amountMinor: 300,
        }),
      ),
    );
    expect(burst.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [status] = await service().listBudgets(t.viewer);
    expect(status?.periods[0]).toMatchObject({ consumedMinor: 900, remainingMinor: 100 });
  });

  it("commits the actual amount and releases unused reservations", async () => {
    if (!db) return;
    const t = await tenant();
    const usage = service();
    await usage.upsertBudget(t.owner, {
      currency: "USD",
      dailyLimitMinor: 1000,
      reason: "fixture",
    });
    const first = await usage.reserve(t.workspaceId, {
      idempotencyKey: "commit-1",
      category: "LLM",
      currency: "USD",
      amountMinor: 400,
    });
    if (first.decision !== "RESERVED") throw new Error("expected a reservation");
    const committed = await usage.commit(t.workspaceId, first.reservation.id, 350);
    expect(committed).toMatchObject({ status: "COMMITTED", committedMinor: 350 });
    await expect(usage.commit(t.workspaceId, first.reservation.id, 350)).resolves.toMatchObject({
      status: "COMMITTED",
    });
    await expect(usage.commit(t.workspaceId, first.reservation.id, 351)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(usage.release(t.workspaceId, first.reservation.id)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const second = await usage.reserve(t.workspaceId, {
      idempotencyKey: "release-1",
      category: "TTS",
      currency: "USD",
      amountMinor: 600,
    });
    if (second.decision !== "RESERVED") throw new Error("expected a reservation");
    expect(second.budgets[0]?.periods[0]?.consumedMinor).toBe(950);
    await expect(usage.release(t.workspaceId, second.reservation.id)).resolves.toMatchObject({
      status: "RELEASED",
    });
    await expect(usage.release(t.workspaceId, second.reservation.id)).resolves.toMatchObject({
      status: "RELEASED",
    });
    await expect(usage.commit(t.workspaceId, second.reservation.id, 10)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const [status] = await usage.listBudgets(t.owner);
    expect(status?.periods[0]).toMatchObject({ consumedMinor: 350, remainingMinor: 650 });
    // Another workspace cannot touch this reservation.
    const other = await tenant();
    await expect(usage.commit(other.workspaceId, first.reservation.id, 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("expires reservations at expiresAt and the sweep marks them EXPIRED", async () => {
    if (!db) return;
    const t = await tenant();
    const usage = service();
    await usage.upsertBudget(t.owner, { currency: "USD", dailyLimitMinor: 500, reason: "fixture" });
    const held = await usage.reserve(t.workspaceId, {
      idempotencyKey: "expire-1",
      category: "LLM",
      currency: "USD",
      amountMinor: 500,
      ttlMs: 60_000,
    });
    if (held.decision !== "RESERVED") throw new Error("expected a reservation");
    await expect(
      usage.reserve(t.workspaceId, {
        idempotencyKey: "expire-2",
        category: "LLM",
        currency: "USD",
        amountMinor: 1,
      }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    clockMs += 61_000;
    const [status] = await usage.listBudgets(t.owner);
    expect(status?.periods[0]?.consumedMinor).toBe(0);
    await expect(usage.sweepExpiredReservations(clock(), t.workspaceId)).resolves.toBe(1);
    await expect(usage.sweepExpiredReservations(clock(), t.workspaceId)).resolves.toBe(0);
    const row = await db.usageReservation.findUniqueOrThrow({ where: { id: held.reservation.id } });
    expect(row).toMatchObject({ status: "EXPIRED", releaseReason: "EXPIRED" });
    await expect(usage.release(t.workspaceId, held.reservation.id)).resolves.toMatchObject({
      status: "EXPIRED",
    });
    // Late actual spend for an expired reservation is still recorded, never hidden.
    await expect(usage.commit(t.workspaceId, held.reservation.id, 120)).resolves.toMatchObject({
      status: "COMMITTED",
      committedMinor: 120,
    });
  });

  it("is idempotent per (workspaceId, idempotencyKey)", async () => {
    if (!db || !secondDb) return;
    const t = await tenant();
    await service().upsertBudget(t.owner, {
      currency: "USD",
      dailyLimitMinor: 1000,
      reason: "fixture",
    });
    const body = { idempotencyKey: "same-key", category: "LLM", currency: "USD", amountMinor: 700 };
    const [a, b] = await Promise.all([
      service(db).reserve(t.workspaceId, body),
      service(secondDb).reserve(t.workspaceId, body),
    ]);
    if (a.decision !== "RESERVED" || b.decision !== "RESERVED") throw new Error("expected both");
    expect(a.reservation.id).toBe(b.reservation.id);
    const again = await service().reserve(t.workspaceId, body);
    expect(again.decision === "RESERVED" ? again.reservation.id : null).toBe(a.reservation.id);
    expect(await db.usageReservation.count({ where: { workspaceId: t.workspaceId } })).toBe(1);
    await expect(
      service().reserve(t.workspaceId, { ...body, amountMinor: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("hard-stops with BUDGET_EXHAUSTED from ledger spend and honors OWNER adjustments", async () => {
    if (!db) return;
    const t = await tenant();
    const usage = service();
    await usage.upsertBudget(t.owner, {
      channelId: t.channelId,
      currency: "USD",
      dailyLimitMinor: 500,
      reason: "channel cap",
    });
    await ledgerRow(t, { actualCost: new Prisma.Decimal("4.001") });
    await expect(usage.evaluatePolicy(t.workspaceId, t.channelId)).resolves.toMatchObject({
      decision: "ALLOWED",
    });
    const error = await usage
      .reserve(t.workspaceId, {
        channelId: t.channelId,
        idempotencyKey: "hard-stop",
        category: "LLM",
        currency: "USD",
        amountMinor: 100,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect(error).toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { consumedMinor: 401, limitMinor: 500, requestedMinor: 100 },
    });
    expect((error as BudgetExhaustedError).getResponse()).toMatchObject({
      code: "BUDGET_EXHAUSTED",
    });

    await usage.createAdjustment(t.owner, {
      channelId: t.channelId,
      kind: "DEBIT",
      currency: "USD",
      amountMinor: 99,
      reason: "provider invoice correction",
    });
    await expect(usage.evaluatePolicy(t.workspaceId, t.channelId)).resolves.toMatchObject({
      decision: "BLOCKED",
      reason: "BUDGET_EXHAUSTED",
    });
    // A workspace-wide reservation without a channel is not limited by the channel budget.
    await expect(usage.evaluatePolicy(t.workspaceId, null)).resolves.toMatchObject({
      decision: "NOT_CONFIGURED",
    });
    await usage.createAdjustment(t.owner, {
      channelId: t.channelId,
      kind: "CREDIT",
      currency: "USD",
      amountMinor: 200,
      reason: "goodwill credit",
    });
    await expect(
      usage.reserve(t.workspaceId, {
        channelId: t.channelId,
        idempotencyKey: "after-credit",
        category: "LLM",
        currency: "USD",
        amountMinor: 200,
      }),
    ).resolves.toMatchObject({ decision: "RESERVED" });
    // Spend in another currency cannot be compared without FX: fail closed.
    await ledgerRow(t, { actualCost: new Prisma.Decimal("1"), currency: "EUR" });
    await expect(usage.evaluatePolicy(t.workspaceId, t.channelId)).resolves.toMatchObject({
      decision: "BLOCKED",
      reason: "BUDGET_CURRENCY_MISMATCH",
    });
  });

  it("keeps OWNER-only admin changes with append-only audit records", async () => {
    if (!db) return;
    const t = await tenant();
    const usage = service();
    const body = { currency: "USD", dailyLimitMinor: 100, reason: "first cap" };
    await expect(usage.upsertBudget(t.editor, body)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(usage.upsertBudget(t.viewer, body)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      usage.createAdjustment(t.editor, {
        kind: "CREDIT",
        currency: "USD",
        amountMinor: 1,
        reason: "nope",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const created = await usage.upsertBudget(t.owner, body);
    clockMs += 1_000;
    const changed = await usage.upsertBudget(t.owner, {
      currency: "USD",
      dailyLimitMinor: 250,
      monthlyLimitMinor: 5000,
      reason: "raise for launch",
      expectedVersion: 1,
    });
    expect(changed).toMatchObject({ version: 2, dailyLimitMinor: 250, monthlyLimitMinor: 5000 });
    await expect(
      usage.upsertBudget(t.owner, { ...body, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(usage.upsertBudget(t.owner, { ...body, currency: "EUR" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    clockMs += 1_000;
    const adjustment = await usage.createAdjustment(t.owner, {
      kind: "DEBIT",
      currency: "USD",
      amountMinor: 40,
      reason: "manual correction",
    });
    const audit = await usage.listAudit(t.viewer);
    expect(audit.map((record) => record.action)).toEqual([
      "DEBIT",
      "LIMIT_CHANGED",
      "BUDGET_CREATED",
    ]);
    const limitChange = audit.find((record) => record.action === "LIMIT_CHANGED");
    expect(limitChange).toMatchObject({
      actorUserId: t.owner.userId,
      reason: "raise for launch",
      budgetId: created.budgetId,
      before: { dailyLimitMinor: 100, monthlyLimitMinor: null, version: 1 },
      after: { dailyLimitMinor: 250, monthlyLimitMinor: 5000, version: 2 },
    });
    expect(limitChange?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    const debit = audit.find((record) => record.action === "DEBIT");
    expect(debit).toMatchObject({
      adjustmentId: adjustment.adjustmentId,
      correlationId: adjustment.correlationId,
      after: { adjustment: { amountMinor: 40, kind: "DEBIT" } },
    });
    expect(debit?.before).toMatchObject({
      budgets: [{ periods: [{ consumedMinor: 0 }, { consumedMinor: 0 }] }],
    });
    expect(debit?.after).toMatchObject({
      budgets: [{ periods: [{ consumedMinor: 40 }, { consumedMinor: 40 }] }],
    });
    // Append-only at the database level.
    await expect(
      db.$executeRaw`UPDATE "usage_audit_records" SET "reason" = 'tampered' WHERE "workspace_id" = ${t.workspaceId}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRaw`DELETE FROM "usage_audit_records" WHERE "workspace_id" = ${t.workspaceId}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRaw`DELETE FROM "usage_adjustments" WHERE "workspace_id" = ${t.workspaceId}::uuid`,
    ).rejects.toThrow(/append-only/);
    expect(await db.usageAuditRecord.count({ where: { workspaceId: t.workspaceId } })).toBe(3);
  });

  it("allows VIEWER reads and denies cross-tenant access", async () => {
    if (!db) return;
    const a = await tenant();
    const b = await tenant();
    const usage = service();
    await usage.upsertBudget(a.owner, { currency: "USD", dailyLimitMinor: 100, reason: "fixture" });
    await expect(usage.listBudgets(a.viewer)).resolves.toHaveLength(1);
    await expect(usage.usageSummary(a.viewer, {})).resolves.toMatchObject({
      workspaceId: a.workspaceId,
    });
    await expect(usage.channelUsage(a.viewer, {})).resolves.toMatchObject({
      channels: [{ channelId: a.channelId }],
    });
    await expect(usage.listBudgets(b.owner)).resolves.toHaveLength(0);
    await expect(usage.usageSummary(b.owner, { channelId: a.channelId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      usage.upsertBudget(b.owner, {
        channelId: a.channelId,
        currency: "USD",
        dailyLimitMinor: 1,
        reason: "cross tenant",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const workspaces = new WorkspaceService(db as never, new WorkspaceRepository(db as never));
    await expect(workspaces.context(b.owner.userId, a.workspaceId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(workspaces.context(a.viewer.userId, a.workspaceId)).resolves.toMatchObject({
      role: "VIEWER",
    });
  });

  it("uses the channel timezone for daily and monthly period boundaries", async () => {
    if (!db) return;
    const t = await tenant("Asia/Kolkata");
    const usage = service();
    // 2026-11-30 23:50 IST.
    clockMs = Date.parse("2026-11-30T18:20:00.000Z");
    await usage.upsertBudget(t.owner, {
      channelId: t.channelId,
      currency: "INR",
      dailyLimitMinor: 1000,
      monthlyLimitMinor: 1500,
      timezone: "UTC",
      reason: "IST cap",
    });
    const before = await usage.reserve(t.workspaceId, {
      channelId: t.channelId,
      idempotencyKey: "tz-1",
      category: "LLM",
      currency: "INR",
      amountMinor: 900,
    });
    if (before.decision !== "RESERVED") throw new Error("expected a reservation");
    expect(before.budgets[0]).toMatchObject({ timezone: "Asia/Kolkata" });
    expect(before.budgets[0]?.periods[0]).toMatchObject({
      period: "DAY",
      periodStart: "2026-11-29T18:30:00.000Z",
      periodEnd: "2026-11-30T18:30:00.000Z",
    });
    await usage.commit(t.workspaceId, before.reservation.id, 900);
    // 2026-12-01 00:05 IST: a new day and a new month in the channel timezone (still Nov 30 UTC).
    clockMs = Date.parse("2026-11-30T18:35:00.000Z");
    const after = await usage.reserve(t.workspaceId, {
      channelId: t.channelId,
      idempotencyKey: "tz-2",
      category: "LLM",
      currency: "INR",
      amountMinor: 1000,
    });
    if (after.decision !== "RESERVED") throw new Error("expected a reservation");
    expect(after.budgets[0]?.periods).toMatchObject([
      { period: "DAY", periodStart: "2026-11-30T18:30:00.000Z", consumedMinor: 1000 },
      { period: "MONTH", periodStart: "2026-11-30T18:30:00.000Z", consumedMinor: 1000 },
    ]);
    const summary = await usage.usageSummary(t.viewer, {
      channelId: t.channelId,
      period: "MONTH",
      date: "2026-11-15",
    });
    expect(summary).toMatchObject({ timezone: "Asia/Kolkata", periodKey: "2026-11" });
    expect(summary.totals.currencies).toMatchObject([{ currency: "INR", committedMinor: 900 }]);
    clockMs = Date.parse("2026-11-10T08:00:00.000Z");
  });

  it("joins the M08 ledger to channel, video (script), job (run) and category without double counting", async () => {
    if (!db) return;
    const t = await tenant();
    const f = await videoFixture(t);
    const usage = service();
    const video = await usage.videoBreakdown(t.viewer, f.scriptId);
    expect(video.lines).toHaveLength(3);
    expect(video.workflowRunIds).toEqual([f.runId]);
    expect(video.renderJobs).toEqual([
      {
        renderJobId: f.renderJobId,
        status: "SUCCEEDED",
        category: "RENDER",
        costKind: "NOT_TRACKED",
      },
    ]);
    const byCategory = Object.fromEntries(
      (video.totals.currencies[0]?.byCategory ?? []).map((item) => [item.category, item]),
    );
    expect(byCategory["LLM"]).toMatchObject({ actualMinor: 13, ledgerRequests: 1 });
    expect(byCategory["IMAGE_MEDIA"]).toMatchObject({ estimatedMinor: 50 });
    // B2: the narration call failed after dispatch without an actual cost: charged at its estimate.
    expect(byCategory["TTS"]).toMatchObject({
      unknownCostRequests: 0,
      failedEstimatedMinor: 20,
      failedEstimatedRequests: 1,
      totalMinor: 20,
    });
    expect(video.totals.unknownCostRequests).toBe(0);
    expect(video.lines.find((line) => line.category === "TTS")).toMatchObject({
      costKind: "FAILED_ESTIMATED",
      costKindLabel: "failed, charged at estimate",
      amountMinor: 20,
    });
    const run = await usage.runBreakdown(t.viewer, f.runId);
    expect(run.lines.map((line) => line.correlationId).sort()).toEqual(
      [f.runCorrelationId, f.imageCorrelationId, f.ttsCorrelationId].sort(),
    );
    const summary = await usage.usageSummary(t.viewer, { channelId: t.channelId });
    expect(summary.totals.currencies[0]).toMatchObject({ currency: "USD", totalMinor: 83 });

    // A COMMITTED M18 reservation for the same correlation replaces the ledger row (no double count).
    await usage.upsertBudget(t.owner, {
      currency: "USD",
      dailyLimitMinor: 10_000,
      reason: "fixture",
    });
    const held = await usage.reserve(t.workspaceId, {
      channelId: t.channelId,
      idempotencyKey: "script-call",
      category: "LLM",
      currency: "USD",
      amountMinor: 20,
      correlationId: f.runCorrelationId,
      workflowRunId: f.runId,
      scriptId: f.scriptId,
    });
    if (held.decision !== "RESERVED") throw new Error("expected a reservation");
    await usage.commit(t.workspaceId, held.reservation.id, 15);
    const again = await usage.videoBreakdown(t.viewer, f.scriptId);
    expect(again.lines).toHaveLength(2);
    expect(again.totals.currencies[0]).toMatchObject({ totalMinor: 85, committedMinor: 15 });
    const [status] = await usage.listBudgets(t.owner);
    expect(status?.periods[0]?.consumedMinor).toBe(85);

    const other = await tenant();
    await expect(usage.videoBreakdown(other.owner, f.scriptId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(usage.runBreakdown(other.owner, f.runId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("lets a failed-after-dispatch call consume budget, but not a pre-dispatch refusal (B2)", async () => {
    if (!db) return;
    const t = await tenant();
    const usage = service();
    await usage.upsertBudget(t.owner, { currency: "USD", dailyLimitMinor: 100, reason: "b2 cap" });
    await ledgerRow(t, {
      status: "FAILED",
      errorCode: "PROVIDER_TIMEOUT",
      estimatedCost: new Prisma.Decimal("0.8"),
    });
    await ledgerRow(t, {
      status: "FAILED",
      errorCode: "NOT_DISPATCHED",
      estimatedCost: new Prisma.Decimal("5"),
    });
    const [status] = await usage.listBudgets(t.owner);
    expect(status?.periods[0]).toMatchObject({ consumedMinor: 80, remainingMinor: 20 });
    await expect(
      usage.reserve(t.workspaceId, {
        idempotencyKey: "b2-over",
        category: "LLM",
        currency: "USD",
        amountMinor: 30,
      }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    await expect(
      usage.reserve(t.workspaceId, {
        idempotencyKey: "b2-fits",
        category: "LLM",
        currency: "USD",
        amountMinor: 20,
      }),
    ).resolves.toMatchObject({ decision: "RESERVED" });
  });

  it("marks a scheduled slot SKIPPED with BUDGET_POLICY_ERROR when the budget policy throws", async () => {
    if (!db) return;
    const t = await tenant("UTC", {
      time: "09:00",
      frequency: "DAILY",
      input: { ideaId: randomUUID() },
    });
    const channels = new ChannelService(db as never);
    const all = channels.listSchedulerCandidates.bind(channels);
    channels.listSchedulerCandidates = async (): ReturnType<typeof all> =>
      (await all()).filter((channel) => channel.workspaceId === t.workspaceId);
    const orchestration = new OrchestrationService(
      db as never,
      new NotConfiguredWorkflowQueue(),
      { dispatchStep: (): Promise<never> => Promise.reject(new Error("not expected")) },
      { evaluate: (): Promise<never> => Promise.reject(new Error("budget store unavailable")) },
      new WorkflowLimitsService(db as never, DEFAULT_WORKFLOW_LIMIT_CONFIG),
      channels,
      { get: () => Promise.resolve({ status: "REVIEW_REQUIRED" }) } as never,
      clock,
    );
    try {
      clockMs = Date.parse("2026-11-10T09:01:00.000Z");
      await expect(orchestration.runSchedulerTick(clock())).resolves.toMatchObject({
        startedRuns: 0,
      });
      await expect(
        db.workflowScheduleSlot.findFirst({
          where: { channelId: t.channelId, slotKey: "GENERATION:2026-11-10T09:00" },
        }),
      ).resolves.toMatchObject({ status: "SKIPPED", reason: "BUDGET_POLICY_ERROR" });
      expect(await db.workflowRun.count({ where: { workspaceId: t.workspaceId } })).toBe(0);
    } finally {
      clockMs = Date.parse("2026-11-10T08:00:00.000Z");
    }
  });

  it("blocks scheduled M16 runs when unconfigured and allows them under budget", async () => {
    if (!db) return;
    const ideaId = randomUUID();
    const t = await tenant("Asia/Kolkata", {
      time: "09:00",
      frequency: "DAILY",
      input: { ideaId },
    });
    const usage = service();
    const channels = new ChannelService(db as never);
    const all = channels.listSchedulerCandidates.bind(channels);
    channels.listSchedulerCandidates = async (): ReturnType<typeof all> =>
      (await all()).filter((channel) => channel.workspaceId === t.workspaceId);
    const dispatcher = {
      dispatchStep: (input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> =>
        Promise.resolve({ resultRef: input.stepKey, resultType: input.stepKey }),
    };
    const orchestration = new OrchestrationService(
      db as never,
      new NotConfiguredWorkflowQueue(),
      dispatcher,
      new UsageBudgetPolicy(usage),
      new WorkflowLimitsService(db as never, DEFAULT_WORKFLOW_LIMIT_CONFIG),
      channels,
      { get: () => Promise.resolve({ status: "REVIEW_REQUIRED" }) } as never,
      clock,
    );
    const slot = (date: string): Promise<unknown> =>
      db.workflowScheduleSlot.findFirst({
        where: { channelId: t.channelId, slotKey: `GENERATION:${date}T09:00` },
      });
    try {
      // 09:00 IST = 03:30Z.
      clockMs = Date.parse("2026-11-10T03:31:00.000Z");
      await expect(orchestration.runSchedulerTick(clock())).resolves.toMatchObject({
        startedRuns: 0,
      });
      await expect(slot("2026-11-10")).resolves.toMatchObject({
        status: "SKIPPED",
        reason: "BUDGET_POLICY_UNAVAILABLE",
      });
      // Manual runs keep M16's rule: allowed while NOT_CONFIGURED.
      await expect(
        orchestration.startManualRun(t.editor, {
          definitionKey: "GENERATION",
          channelId: t.channelId,
          ideaId,
        }),
      ).resolves.toMatchObject({ budgetDecision: "NOT_CONFIGURED" });

      await usage.upsertBudget(t.owner, {
        channelId: t.channelId,
        currency: "INR",
        dailyLimitMinor: 50_000,
        reason: "enable autonomy",
      });
      clockMs = Date.parse("2026-11-11T03:31:00.000Z");
      await expect(orchestration.runSchedulerTick(clock())).resolves.toMatchObject({
        startedRuns: 1,
      });
      await expect(slot("2026-11-11")).resolves.toMatchObject({ status: "STARTED" });
      const scheduled = await db.workflowRun.findFirst({
        where: { workspaceId: t.workspaceId, trigger: "SCHEDULED" },
      });
      expect(scheduled).toMatchObject({ budgetDecision: "ALLOWED" });

      // Exhausted budget: hard stop for both triggers.
      clockMs = Date.parse("2026-11-12T03:00:00.000Z");
      await usage.createAdjustment(t.owner, {
        channelId: t.channelId,
        kind: "DEBIT",
        currency: "INR",
        amountMinor: 50_000,
        reason: "spent elsewhere",
      });
      clockMs = Date.parse("2026-11-12T03:31:00.000Z");
      await expect(orchestration.runSchedulerTick(clock())).resolves.toMatchObject({
        startedRuns: 0,
      });
      await expect(slot("2026-11-12")).resolves.toMatchObject({
        status: "SKIPPED",
        reason: "BUDGET_EXHAUSTED",
      });
      await expect(
        orchestration.startManualRun(t.editor, {
          definitionKey: "GENERATION",
          channelId: t.channelId,
          ideaId,
        }),
      ).rejects.toThrow(/BUDGET_EXHAUSTED/);
    } finally {
      // Keep these runs out of other suites' recovery sweeps.
      await db.workflowRun.updateMany({
        where: { workspaceId: t.workspaceId },
        data: { state: "CANCELED" },
      });
      clockMs = Date.parse("2026-11-10T08:00:00.000Z");
    }
  });

  async function videoFixture(t: Tenant): Promise<{
    scriptId: string;
    runId: string;
    runCorrelationId: string;
    imageCorrelationId: string;
    ttsCorrelationId: string;
    renderJobId: string;
  }> {
    if (!db) throw new Error("database unavailable");
    const ownerId = t.owner.userId;
    const ideaId = randomUUID();
    const snapshotId = randomUUID();
    const scriptId = randomUUID();
    const configSnapshotId = randomUUID();
    const templateId = randomUUID();
    const templateVersionId = randomUUID();
    const promptSnapshotId = randomUUID();
    const runId = randomUUID();
    const runCorrelationId = randomUUID();
    const sceneMediaJobId = randomUUID();
    const sceneGenerationId = randomUUID();
    const imageCorrelationId = randomUUID();
    const ttsCorrelationId = randomUUID();
    const renderJobId = randomUUID();
    const workspaceId = t.workspaceId;
    await db.idea.create({
      data: {
        id: ideaId,
        workspaceId,
        channelId: t.channelId,
        origin: "USER",
        status: "APPROVED",
        title: "m18",
        normalizedTitle: "m18",
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        approvedAt: clock(),
        createdByUserId: ownerId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        ideaId,
        channelId: t.channelId,
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        checksumSha256: "checksum",
      },
    });
    await db.script.create({
      data: {
        id: scriptId,
        workspaceId,
        channelId: t.channelId,
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        status: "APPROVED",
        createdByUserId: ownerId,
      },
    });
    await db.configSnapshot.create({
      data: {
        id: configSnapshotId,
        workspaceId,
        version: 1,
        config: {},
        fingerprintSha256: "b".repeat(64),
        resolutionSha256: "c".repeat(64),
        layers: [],
        lockedFields: [],
      },
    });
    await db.promptTemplate.create({
      data: { id: templateId, workspaceId, key: `m18-${templateId}`, name: "M18" },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: templateVersionId,
        workspaceId,
        templateId,
        version: 1,
        status: "PUBLISHED",
        body: {},
        checksumSha256: "a".repeat(64),
      },
    });
    await db.promptBundleSnapshot.create({
      data: {
        id: promptSnapshotId,
        workspaceId,
        version: 1,
        configSnapshotId,
        templateId,
        templateVersionId,
        bundle: {},
        fingerprintSha256: "d".repeat(64),
      },
    });
    await db.workflowRun.create({
      data: {
        id: runId,
        workspaceId,
        channelId: t.channelId,
        correlationId: runCorrelationId,
        idempotencyKey: `m18-${runId}`,
        state: "CANCELED",
      },
    });
    await db.workflowStep.createMany({
      data: [
        {
          workspaceId,
          runId,
          stepKey: "GENERATE_SCRIPT",
          sequence: 2,
          status: "SUCCEEDED",
          idempotencyKey: `${runId}:script`,
          resultRef: scriptId,
          resultType: "SCRIPT",
        },
        {
          workspaceId,
          runId,
          stepKey: "GENERATE_SCENE_MEDIA",
          sequence: 3,
          status: "SUCCEEDED",
          idempotencyKey: `${runId}:media`,
          resultRef: sceneMediaJobId,
          resultType: "SCENE_MEDIA_PACKAGE",
        },
      ],
    });
    // Script LLM call: actual 0.123 USD -> 13 minor (rounded up). Carries the run correlation id.
    await ledgerRow(t, {
      correlationId: runCorrelationId,
      capabilityId: "llm",
      actualCost: new Prisma.Decimal("0.123"),
    });
    // Image call succeeded with no actual cost: charged at its estimate (ESTIMATED).
    await ledgerRow(t, {
      correlationId: imageCorrelationId,
      capabilityId: "scene-image",
      estimatedCost: new Prisma.Decimal("0.5"),
    });
    // Narration call failed after dispatch with no actual cost: charged at its estimate (B2).
    await ledgerRow(t, {
      correlationId: ttsCorrelationId,
      capabilityId: "narration",
      status: "FAILED",
      errorCode: "PROVIDER_ERROR",
      estimatedCost: new Prisma.Decimal("0.2"),
    });
    await db.sceneMediaJob.create({
      data: {
        id: sceneMediaJobId,
        workspaceId,
        scriptId,
        scriptRevision: 1,
        channelId: t.channelId,
        idempotencyKey: `m18-${sceneMediaJobId}`,
        requestedOutputs: [],
        configSnapshotId,
        promptSnapshotId,
        createdByUserId: ownerId,
      },
    });
    await db.sceneGeneration.create({
      data: {
        id: sceneGenerationId,
        workspaceId,
        jobId: sceneMediaJobId,
        sceneId: "scene-1",
        ordinal: 1,
        sceneVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `m18-${sceneGenerationId}`,
        resolvedPrompt: "prompt",
        sourceRefs: [],
      },
    });
    await db.sceneGenerationOutput.createMany({
      data: [
        {
          workspaceId,
          sceneGenerationId,
          kind: "IMAGE",
          status: "QUEUED",
          correlationId: imageCorrelationId,
        },
        {
          workspaceId,
          sceneGenerationId,
          kind: "NARRATION",
          status: "FAILED_FINAL",
          correlationId: ttsCorrelationId,
        },
      ],
    });
    await db.renderJob.create({
      data: {
        id: renderJobId,
        workspaceId,
        sceneMediaJobId,
        idempotencyKey: `m18-${renderJobId}`,
        status: "SUCCEEDED",
        inputFingerprint: "e".repeat(64),
        input: {},
        createdByUserId: ownerId,
      },
    });
    return {
      scriptId,
      runId,
      runCorrelationId,
      imageCorrelationId,
      ttsCorrelationId,
      renderJobId,
    };
  }
});
