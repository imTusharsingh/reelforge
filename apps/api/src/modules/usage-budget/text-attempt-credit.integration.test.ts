import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { afterEach, expect, it, vi } from "vitest";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Step } from "../runs/runs.types.js";
import { deliverTextObservation } from "./text-attempt-delivery.js";
import { confirmTextAttempt } from "./text-attempt-owner.js";
import type { PaidTextResult } from "./text-attempt-runtime.js";
import { UsageBudgetService } from "./usage-budget.service.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);
afterEach(() => vi.unstubAllEnvs());

async function preparedAttempt(): Promise<{
  tenant: Tenant;
  access: ReturnType<typeof bindMedia>["access"];
  accounts: ReturnType<typeof bindMedia>["accounts"];
  step: Step;
}> {
  const tenant = await fixture.tenant();
  const { engine, runs, store, context, run: created } = tenant;
  await engine.process(runs.job(context, created.id));
  const run = await store.get(context, created.id);
  const native = fakeMediaPorts(
    context.workspaceId,
    tenant.storage,
    { clip: Buffer.alloc(0), image: Buffer.alloc(0), audio: Buffer.alloc(0) },
    [],
  );
  const { accounts, access } = bindMedia(tenant, native);
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
  const step = await accounts.begin(
    context,
    run,
    "media:text:scriptwriter",
    {},
    7,
    "fixture-text",
    true,
  );
  return { tenant, accounts, access, step };
}

async function creditedAttempt(): Promise<{ tenant: Tenant; stepId: string; chargeDate: Date }> {
  const { tenant, accounts, step } = await preparedAttempt();
  const { context } = tenant;
  const send = vi.fn(async (bodySent: () => Promise<void>): Promise<PaidTextResult> => {
    await bodySent();
    return {
      output: { draft: "fixture" },
      dispatchKey: step.idempotencyKey,
      providerJobId: null,
      usage: { input_tokens: 5 },
    };
  });
  await accounts.dispatchTextAttempt(context, step, send);
  expect(send).toHaveBeenCalledOnce();
  const original = await tenant.db.usageReservation.findFirstOrThrow({
    where: { workspaceId: context.workspaceId, correlationId: step.id },
  });
  expect(original).toMatchObject({ status: "COMMITTED", committedMinor: 7n });
  return { tenant, stepId: step.id, chargeDate: original.createdAt };
}

test("credits bind to one attempt, replay atomically and cannot reduce unrelated spend", async () => {
  const { tenant: t, stepId, chargeDate } = await creditedAttempt();
  let now = chargeDate;
  const usage = new UsageBudgetService(t.db, () => now);
  const adjust = (body: unknown): ReturnType<UsageBudgetService["createAdjustment"]> =>
    usage.createAdjustment(t.context, body);
  const credit = {
    kind: "CREDIT",
    textAttemptId: stepId,
    operationKey: "first-credit",
    amountMinor: 2,
    reason: "provider credit note",
  };
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
  await expect(adjust(credit)).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(await t.db.usageAdjustment.count({ where: { textAttemptId: stepId } })).toBe(0);
  await adjust({ kind: "DEBIT", currency: "USD", amountMinor: 4, reason: "unrelated spend" });
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
  now = new Date(chargeDate.getTime() + 24 * 60 * 60_000);
  await expect(adjust({ ...credit, channelId: t.run.channelId })).rejects.toBeInstanceOf(
    BadRequestException,
  );
  await expect(
    usage.createAdjustment({ ...t.context, role: "EDITOR" }, credit),
  ).rejects.toBeInstanceOf(ForbiddenException);
  const other = await fixture.tenant();
  await expect(usage.createAdjustment(other.context, credit)).rejects.toThrow();
  const [first, replay] = await Promise.all([adjust(credit), adjust(credit)]);
  expect(replay).toMatchObject({
    adjustmentId: first.adjustmentId,
    correlationId: first.correlationId,
  });
  await expect(adjust({ ...credit, amountMinor: 1 })).rejects.toBeInstanceOf(ConflictException);
  await expect(
    adjust({ ...credit, operationKey: "excess", amountMinor: 6 }),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(await t.db.usageAdjustment.findMany({ where: { textAttemptId: stepId } })).toMatchObject([
    { id: first.adjustmentId, amountMinor: 2n, currency: "USD", channelId: t.run.channelId },
  ]);
  expect(await t.db.usageAuditRecord.count({ where: { adjustmentId: first.adjustmentId } })).toBe(
    1,
  );

  const originalDay = (date: Date): string => date.toISOString().slice(0, 10);
  expect(
    (await usage.usageSummary(t.context, { date: originalDay(chargeDate) })).totals.currencies,
  ).toMatchObject([{ currency: "USD", committedMinor: 5, adjustmentNetMinor: 4, totalMinor: 9 }]);
  expect(
    (await usage.usageSummary(t.context, { date: originalDay(now) })).totals.currencies,
  ).toEqual([]);
  const perChannel = await usage.channelUsage(t.context, { date: originalDay(chargeDate) });
  expect(
    perChannel.channels.find((row) => row.channelId === t.run.channelId)?.totals.currencies,
  ).toMatchObject([{ currency: "USD", committedMinor: 5, adjustmentNetMinor: 0, totalMinor: 5 }]);
  await adjust({ ...credit, operationKey: "full-credit", amountMinor: 5 });
  expect(
    (await usage.usageSummary(t.context, { date: originalDay(chargeDate) })).totals.currencies,
  ).toMatchObject([{ currency: "USD", committedMinor: 0, adjustmentNetMinor: 4, totalMinor: 4 }]);
  now = chargeDate;
  expect((await usage.listBudgets(t.context))[0]?.periods).toEqual(
    expect.arrayContaining([expect.objectContaining({ period: "DAY", consumedMinor: 4 })]),
  );
});

async function rejectedAttempt(): Promise<{
  tenant: Tenant;
  step: Step;
  send: { mock: { calls: unknown[][] } };
  reject: () => ReturnType<typeof deliverTextObservation>;
  confirm: () => ReturnType<typeof confirmTextAttempt>;
}> {
  const { tenant, access, accounts, step } = await preparedAttempt();
  const { context } = tenant;
  const send = vi.fn(async (bodySent: () => Promise<void>): Promise<PaidTextResult> => {
    await bodySent();
    throw new Error("response unavailable");
  });
  await expect(accounts.dispatchTextAttempt(context, step, send)).rejects.toThrow(
    "response unavailable",
  );
  const arm = await tenant.db.textAttemptEvidence.findFirstOrThrow({
    where: { attemptId: step.id, kind: "ARMED" },
  });
  const reject = (): ReturnType<typeof deliverTextObservation> =>
    deliverTextObservation(access, context, step, arm.nonce!, {
      kind: "REJECTED",
      data: { dispatchKey: step.idempotencyKey, code: "INVALID_ARGUMENT", httpStatus: 400 },
    });
  const confirm = (): ReturnType<typeof confirmTextAttempt> =>
    confirmTextAttempt(tenant.runs, context, step.runId, step.id);
  return { tenant, step, send, reject, confirm };
}

test.each([
  { amountMinor: 3, rejectFirst: false },
  { amountMinor: 7, rejectFirst: false },
  { amountMinor: 3, rejectFirst: true },
  { amountMinor: 7, rejectFirst: true },
])(
  "credits $amountMinor/7 on either side of rejection (reject first: $rejectFirst)",
  async ({ amountMinor, rejectFirst }) => {
    const { tenant: t, step, send, reject, confirm } = await rejectedAttempt();
    const { context } = t;
    await confirm();
    const original = await t.db.usageReservation.findFirstOrThrow({
      where: { correlationId: step.id },
    });
    expect(original).toMatchObject({ status: "COMMITTED", committedMinor: 7n });
    const usage = new UsageBudgetService(t.db, () => original.createdAt);
    await usage.createAdjustment(context, {
      kind: "DEBIT",
      currency: "USD",
      amountMinor: 5,
      reason: "unrelated spend",
    });
    await usage.createAdjustment(context, {
      kind: "BUDGET_CREDIT",
      currency: "USD",
      amountMinor: 1,
      reason: "independent allowance",
    });
    const credit = {
      kind: "CREDIT",
      textAttemptId: step.id,
      operationKey: "linked-credit",
      amountMinor,
      reason: "provider adjustment",
    };
    await expect(
      usage.createAdjustment(context, {
        kind: "CREDIT",
        currency: "USD",
        amountMinor,
        reason: "provider adjustment",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    if (rejectFirst) await reject();
    const posted = await usage.createAdjustment(context, credit);
    if (!rejectFirst) {
      expect(
        await t.db.textAttemptProjection.findFirstOrThrow({ where: { attemptId: step.id } }),
      ).toMatchObject({ grossMinor: 7, netMinor: 7 - amountMinor, reservedMinor: 0 });
      await reject();
    }
    expect(
      await t.db.textAttemptProjection.findFirstOrThrow({ where: { attemptId: step.id } }),
    ).toMatchObject({ grossMinor: 0, netMinor: 0, reservedMinor: 0 });
    expect(
      await t.db.usageReservation.findUniqueOrThrow({ where: { id: original.id } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: 0n });
    expect(await usage.createAdjustment(context, credit)).toMatchObject({
      adjustmentId: posted.adjustmentId,
      correlationId: posted.correlationId,
    });
    await expect(
      usage.createAdjustment(context, {
        ...credit,
        operationKey: "exceeds-original",
        amountMinor: 8 - amountMinor,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await t.db.usageAdjustment.count({ where: { textAttemptId: step.id } })).toBe(1);
    expect(
      await t.db.usageAuditRecord.count({ where: { adjustmentId: posted.adjustmentId } }),
    ).toBe(1);
    expect(
      (await usage.usageSummary(context, { date: original.createdAt.toISOString().slice(0, 10) }))
        .totals.currencies,
    ).toMatchObject([{ currency: "USD", totalMinor: 4 }]);
    expect((await usage.listBudgets(context))[0]?.periods).toEqual(
      expect.arrayContaining([expect.objectContaining({ period: "DAY", consumedMinor: 4 })]),
    );
    expect(send).toHaveBeenCalledOnce();
  },
);

test("does not credit a rejected attempt whose reservation was never committed", async () => {
  const { tenant: t, step, reject } = await rejectedAttempt();
  await reject();
  expect(
    await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: step.id } }),
  ).toMatchObject({ status: "RELEASED", committedMinor: null });
  await expect(
    t.usage.createAdjustment(t.context, {
      kind: "CREDIT",
      textAttemptId: step.id,
      operationKey: "unbooked-credit",
      amountMinor: 1,
      reason: "provider adjustment",
    }),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(await t.db.usageAdjustment.count({ where: { textAttemptId: step.id } })).toBe(0);
});
