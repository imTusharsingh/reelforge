import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { NotConfiguredBillingProvider, type BillingProviderPort } from "./usage-budget.billing.js";
import { categorize, classifyCost, type LedgerRow } from "./usage-budget.ledger.js";
import { decimalToMinor, minorToNumber, minorUnitExponent } from "./usage-budget.money.js";
import { UsageBudgetPolicy } from "./usage-budget.policy.js";
import { UsageBudgetService } from "./usage-budget.service.js";
import { UsageTotals } from "./usage-budget.totals.js";
import { BillingNotConfiguredError, BudgetExhaustedError } from "./usage-budget.types.js";
import { parseAdjustment, parseReserve, parseUpsertBudget } from "./usage-budget.validation.js";

const now = new Date("2026-11-10T08:00:00.000Z");

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: "row",
    channelId: null,
    correlationId: "c",
    providerId: "fixture",
    capabilityId: "llm",
    status: "SUCCEEDED",
    errorCode: null,
    estimatedCost: null,
    actualCost: null,
    currency: "USD",
    createdAt: now,
    sceneKind: null,
    sceneMediaJobId: null,
    scriptId: null,
    workflowRunId: null,
    ...overrides,
  };
}

describe("M18 money", () => {
  it("converts ledger decimals to minor units, rounding up, per currency exponent", () => {
    expect(decimalToMinor("0.12345678", "USD")).toBe(13n);
    expect(decimalToMinor("4.00", "USD")).toBe(400n);
    expect(decimalToMinor("12.1", "JPY")).toBe(13n);
    expect(decimalToMinor("1.0001", "KWD")).toBe(1001n);
    expect(minorUnitExponent("INR")).toBe(2);
    expect(() => minorToNumber(2n ** 60n)).toThrow(RangeError);
  });
});

describe("M18 ledger classification", () => {
  it("prefers actual cost, falls back to estimates for succeeded or pending calls, else UNKNOWN", () => {
    expect(classifyCost(row({ actualCost: "0.5", estimatedCost: "9" }))).toEqual({
      kind: "ACTUAL",
      amountMinor: 50n,
      currency: "USD",
    });
    expect(classifyCost(row({ estimatedCost: "0.25" }))).toMatchObject({
      kind: "ESTIMATED",
      amountMinor: 25n,
    });
    expect(
      classifyCost(row({ status: "FAILED", errorCode: "PENDING", estimatedCost: "1" })),
    ).toMatchObject({ kind: "ESTIMATED", amountMinor: 100n });
    expect(
      classifyCost(row({ status: "FAILED", errorCode: "TIMEOUT", estimatedCost: "1" })),
    ).toMatchObject({ kind: "UNKNOWN", amountMinor: null });
    expect(classifyCost(row({ actualCost: "1", currency: null }))).toMatchObject({
      kind: "ACTUAL",
      amountMinor: null,
      currency: null,
    });
  });

  it("maps scene output kind first, then capability keywords, else UNCATEGORIZED", () => {
    expect(categorize(row({ sceneKind: "VIDEO", capabilityId: "llm" }))).toBe("IMAGE_MEDIA");
    expect(categorize(row({ sceneKind: "DIALOGUE" }))).toBe("TTS");
    expect(categorize(row({ capabilityId: "llm" }))).toBe("LLM");
    expect(categorize(row({ capabilityId: "tts-v1" }))).toBe("TTS");
    expect(categorize(row({ capabilityId: "image-gen" }))).toBe("IMAGE_MEDIA");
    expect(categorize(row({ capabilityId: "youtube-upload" }))).toBe("PUBLISH");
    expect(categorize(row({ capabilityId: "analytics-report" }))).toBe("ANALYTICS_API");
    expect(categorize(row({ capabilityId: "mystery", providerId: "acme" }))).toBe("UNCATEGORIZED");
  });
});

describe("M18 usage totals", () => {
  it("aggregates ledger, live/committed reservations and net adjustments per currency", () => {
    const view = new UsageTotals(now)
      .addLedger(row({ actualCost: "1.00" }))
      .addLedger(row({ estimatedCost: "0.50", capabilityId: "image" }))
      .addLedger(row({ status: "FAILED", errorCode: "X" }))
      .addLedger(row({ actualCost: "2", currency: null }))
      .addReservation({
        category: "RENDER",
        currency: "USD",
        amountMinor: 30n,
        committedMinor: null,
        status: "RESERVED",
        expiresAt: new Date(now.getTime() + 1),
      })
      .addReservation({
        category: "RENDER",
        currency: "USD",
        amountMinor: 30n,
        committedMinor: null,
        status: "RESERVED",
        expiresAt: now,
      })
      .addReservation({
        category: "PUBLISH",
        currency: "USD",
        amountMinor: 10n,
        committedMinor: 7n,
        status: "COMMITTED",
        expiresAt: now,
      })
      .addAdjustment({ kind: "DEBIT", currency: "USD", amountMinor: 5n })
      .addAdjustment({ kind: "CREDIT", currency: "USD", amountMinor: 2n })
      .view();
    expect(view.unknownCostRequests).toBe(1);
    expect(view.unpricedRequests).toBe(1);
    expect(view.currencies).toHaveLength(1);
    expect(view.currencies[0]).toMatchObject({
      currency: "USD",
      actualMinor: 100,
      estimatedMinor: 50,
      reservedMinor: 30,
      committedMinor: 7,
      adjustmentNetMinor: 3,
      totalMinor: 190,
    });
    expect(view.currencies[0]?.byCategory.map((item) => item.category)).toEqual([
      "LLM",
      "IMAGE_MEDIA",
      "RENDER",
      "PUBLISH",
    ]);
  });
});

describe("M18 validation", () => {
  it("accepts only integer minor units and ISO currencies", () => {
    expect(() =>
      parseUpsertBudget({ currency: "USD", dailyLimitMinor: 10.5, reason: "cap" }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseUpsertBudget({ currency: "usd", dailyLimitMinor: 10, reason: "cap" }),
    ).toThrow(BadRequestException);
    expect(() => parseUpsertBudget({ currency: "USD", reason: "no limits" })).toThrow(
      BadRequestException,
    );
    expect(() =>
      parseUpsertBudget({ currency: "USD", dailyLimitMinor: 1, reason: "cap", timezone: "Mars/X" }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseAdjustment({ kind: "DEBIT", currency: "USD", amountMinor: 0, reason: "zero" }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseReserve({ idempotencyKey: "k", category: "FAX", currency: "USD", amountMinor: 1 }),
    ).toThrow(BadRequestException);
    expect(
      parseReserve({ idempotencyKey: "k", category: "RENDER", currency: "USD", amountMinor: 0 }),
    ).toMatchObject({ amountMinor: 0 });
  });
});

describe("M18 roles, policy adapter and billing extension point", () => {
  const service = new UsageBudgetService({} as never, () => now);

  it("rejects non-OWNER admin writes before touching the database", async () => {
    for (const role of ["EDITOR", "VIEWER"] as const) {
      const context = { workspaceId: "w", userId: "u", role };
      await expect(
        service.upsertBudget(context, { currency: "USD", dailyLimitMinor: 1, reason: "cap" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createAdjustment(context, {
          kind: "CREDIT",
          currency: "USD",
          amountMinor: 1,
          reason: "fix",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("maps evaluations onto the M16 BudgetPolicyPort contract and never swallows errors", async () => {
    const results = [
      { decision: "NOT_CONFIGURED", reason: "BUDGET_POLICY_UNAVAILABLE", budgets: [] },
      { decision: "BLOCKED", reason: "BUDGET_EXHAUSTED", budgets: [] },
      { decision: "ALLOWED", reason: null, budgets: [] },
    ] as const;
    for (const result of results) {
      const policy = new UsageBudgetPolicy({
        evaluatePolicy: () => Promise.resolve(result),
      } as never);
      await expect(
        policy.evaluate({
          workspaceId: "w",
          channelId: null,
          definitionKey: "GENERATION",
          trigger: "SCHEDULED",
        }),
      ).resolves.toEqual({ decision: result.decision, reason: result.reason });
    }
    const failing = new UsageBudgetPolicy({
      evaluatePolicy: () => Promise.reject(new Error("db down")),
    } as never);
    await expect(
      failing.evaluate({
        workspaceId: "w",
        channelId: null,
        definitionKey: "GENERATION",
        trigger: "SCHEDULED",
      }),
    ).rejects.toThrow("db down");
  });

  it("exposes a typed BUDGET_EXHAUSTED error", () => {
    const error = new BudgetExhaustedError({
      budgetId: "b",
      period: "DAY",
      limitMinor: 10,
      consumedMinor: 10,
      requestedMinor: 1,
      currency: "USD",
    });
    expect(error.code).toBe("BUDGET_EXHAUSTED");
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: "BUDGET_EXHAUSTED", limitMinor: 10 });
  });

  it("keeps billing NOT_CONFIGURED with no payment adapter", async () => {
    const billing: BillingProviderPort = new NotConfiguredBillingProvider();
    expect(billing.status).toBe("NOT_CONFIGURED");
    await expect(
      billing.ensureCustomer({ workspaceId: "w", correlationId: "c" }),
    ).rejects.toBeInstanceOf(BillingNotConfiguredError);
    await expect(
      billing.reportUsage({
        workspaceId: "w",
        periodKey: "2026-11",
        currency: "USD",
        amountMinor: 1,
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(BillingNotConfiguredError);
  });
});
