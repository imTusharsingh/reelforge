import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import { legacy } from "./legacy-text-import.fixture.js";
import { importLegacyTextAttempts } from "./legacy-text-import.js";
import { drainedLegacyIncarnation } from "./text-attempt-ops-schema.js";
import { ingestMatchedTextRejection } from "./text-attempt-receipt-recovery.js";
import { readTextAttempt } from "./text-attempt-store.js";

async function historicalCredit(
  t: Tenant,
  target: { textAttemptId: string; dispatchKey: string } | { providerRequestId: string },
): Promise<string> {
  const { workspaceId, channelId } = t.run;
  const base = {
    workspaceId,
    channelId,
    actorUserId: t.context.userId,
    correlationId: randomUUID(),
    reason: "matched refund",
  };
  const row = await t.db.usageAdjustment.create({
    data: { ...base, kind: "CREDIT", currency: "USD", amountMinor: 3n },
  });
  await t.db.usageAuditRecord.create({
    data: {
      workspaceId,
      actorUserId: base.actorUserId,
      correlationId: base.correlationId,
      reason: base.reason,
      action: "CREDIT",
      adjustmentId: row.id,
      after: {
        adjustment: {
          id: row.id,
          channelId,
          operationKey: `refund:${row.id}`,
          amountMinor: 3,
          currency: "USD",
          ...target,
        },
      },
    },
  });
  return row.id;
}

describe.skipIf(!process.env.DATABASE_URL)("workspace credit cutover", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it("links both proven refunds before folding either pending 401", async () => {
    const t = await fixture.tenant();
    const { workspaceId } = t.run;
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
    const options = { workspaceId, apply: true, oldWritersDrained: true, auditId: "two-bookings" };
    const steps = [];
    for (const key of ["first", "second"]) {
      const step = await legacy(t, key, { committed: true });
      await t.store.mutate(t.context, t.run.id, "step_failed", async () => ({
        value: null,
        stepId: step.id,
        payload: {
          reason: "OWNER_CONFIRMED_TERMINAL_TEXT",
          confirmedBy: t.context.userId,
          committedEstimateMinor: 7,
        },
      }));
      steps.push(step);
    }
    expect(
      (await importLegacyTextAttempts(t.db, options)).attempts.map((row) => row.outcome),
    ).toEqual(["owner-settled", "owner-settled"]);
    for (const step of steps) {
      const dispatchKey = step.idempotencyKey;
      await historicalCredit(t, { textAttemptId: step.id, dispatchKey });
      const state = await readTextAttempt(t.db, step);
      await expect(
        ingestMatchedTextRejection(t.db, {
          target: {
            workspaceId,
            attemptId: step.id,
            dispatchKey,
            armNonce: state!.armNonce,
            incarnation: drainedLegacyIncarnation,
          },
          actor: "operator",
          source: "google-project-audit",
          reference: `401-${step.id}`,
          observedAt: new Date().toISOString(),
          httpStatus: 401,
          code: "UNAUTHENTICATED",
        }),
      ).rejects.toThrow("unattributed");
    }
    const applied = await importLegacyTextAttempts(t.db, options);
    expect(applied.unresolvedCreditIds).toEqual([]);
    expect(applied.attempts.map((row) => [row.action, row.after?.netMinor])).toEqual([
      ["reconciled", 0],
      ["reconciled", 0],
    ]);
    await importLegacyTextAttempts(t.db, options);
    for (const step of steps) {
      expect(
        await t.db.usageReservation.findFirstOrThrow({
          where: { workspaceId, correlationId: step.id },
        }),
      ).toMatchObject({ status: "COMMITTED", committedMinor: 0n });
      expect(
        await t.db.usageAdjustment.count({ where: { workspaceId, textAttemptId: step.id } }),
      ).toBe(1);
      expect(
        await t.db.textAttemptEvidence.count({
          where: { workspaceId, attemptId: step.id, kind: "CREDIT" },
        }),
      ).toBe(1);
    }
    expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(0);
  });
  it("attributes the historical media refund in place and preserves exposure on replay", async () => {
    const t = await fixture.tenant();
    const { workspaceId, channelId } = t.run;
    const charge = await t.db.providerRequest.create({
      data: {
        workspaceId,
        channelId,
        correlationId: randomUUID(),
        providerId: "video",
        capabilityId: "video",
        status: "FAILED",
        errorCode: "REFUSED",
        estimatedCost: "0.07",
        currency: "USD",
      },
    });
    const id = await historicalCredit(t, { providerRequestId: charge.id });
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
    expect(await importLegacyTextAttempts(t.db, { workspaceId })).toMatchObject({
      unresolvedCreditIds: [id],
      mediaCreditLinks: [{ adjustmentId: id, providerRequestId: charge.id }],
    });
    const original = await t.db.usageAdjustment.findUniqueOrThrow({ where: { id } });
    const options = { workspaceId, apply: true, oldWritersDrained: true, auditId: "media-refund" };
    expect((await importLegacyTextAttempts(t.db, options)).unresolvedCreditIds).toEqual([]);
    expect((await importLegacyTextAttempts(t.db, options)).mediaCreditLinks).toEqual([]);
    expect(
      await t.db.usageAuditRecord.count({
        where: {
          workspaceId,
          adjustmentId: id,
          after: { path: ["auditId"], equals: options.auditId },
        },
      }),
    ).toBe(1);
    expect(await t.db.usageAdjustment.findMany({ where: { workspaceId } })).toEqual([
      { ...original, operationKey: `refund:${id}`, providerRequestId: charge.id },
    ]);
    expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(4);
    expect(
      (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
    ).toMatchObject({ failedEstimatedMinor: 4, adjustmentNetMinor: 0 });
  });
});
