import { workerVideo } from "./worker-video.fixture.js";
import { RunPaidCalls } from "./run-paid.js";
import { captureShotReceipt } from "./run-billing.js";
import { refusedRoutedJob } from "./routed-refusal.fixture.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { historicalCredit } from "./legacy-credit-cutover.fixture.js";
import { legacy } from "./legacy-text-import.fixture.js";
import { importLegacyTextAttempts } from "./legacy-text-import.js";
import { drainedLegacyIncarnation } from "./text-attempt-ops-schema.js";
import { ingestMatchedTextRejection } from "./text-attempt-receipt-recovery.js";
import { readTextAttempt } from "./text-attempt-store.js";

describe.skipIf(!process.env.DATABASE_URL)("workspace credit cutover", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it.each([true, false])(
    "folds both pending 401s when the first booking also has a refund: %s",
    async (both) => {
      const t = await fixture.tenant();
      const { workspaceId } = t.run;
      vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
      const options = {
        workspaceId,
        apply: true,
        oldWritersDrained: true,
        auditId: "two-bookings",
      };
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
        if (both || step === steps[1])
          await historicalCredit(t, { textAttemptId: step.id, dispatchKey });
      }
      for (const step of steps) {
        const dispatchKey = step.idempotencyKey;
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
        ).toBe(both || step === steps[1] ? 1 : 0);
        expect(
          await t.db.textAttemptEvidence.count({
            where: { workspaceId, attemptId: step.id, kind: "CREDIT" },
          }),
        ).toBe(both || step === steps[1] ? 1 : 0);
      }
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(0);
    },
  );
  it.each(["before", "after"])(
    "keeps the verified bill arriving %s historical media credit cutover",
    async (order) => {
      const t = await fixture.tenant();
      const { workspaceId, channelId } = t.run;
      const job = await refusedRoutedJob(t);
      const id = await historicalCredit(t, { providerRequestId: job.requestId });
      vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
      const options = {
        workspaceId,
        apply: true,
        oldWritersDrained: true,
        auditId: "verified-bill",
      };
      if (order === "before") await job.bill(4);
      expect((await importLegacyTextAttempts(t.db, options)).unresolvedCreditIds).toEqual([]);
      if (order === "after") await job.bill(4);
      expect((await importLegacyTextAttempts(t.db, options)).mediaCreditLinks).toEqual([]);
      expect(await t.db.usageAdjustment.findMany({ where: { workspaceId } })).toMatchObject([
        { id, providerRequestId: job.requestId, amountMinor: 3n },
      ]);
      const where = { workspaceId, correlationId: job.correlationId };
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        committedMinor: 4n,
      });
      expect((await t.db.providerRequest.findFirstOrThrow({ where })).actualCost?.toString()).toBe(
        "0.04",
      );
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(4);
      expect(
        (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
      ).toMatchObject({
        totalMinor: 4,
        adjustmentNetMinor: 0,
      });
    },
  );
  it.each(["BUDGET_DENIED_NOT_DISPATCHED", "NOT_DISPATCHED"])(
    "recognizes main's %s release with no accounting rows, without seeding a retry",
    async (closedBy) => {
      const t = await fixture.tenant();
      const { workspaceId, id: runId } = t.run;
      vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
      const denied = await t.db.videoRunStep.create({
        data: {
          workspaceId,
          runId,
          state: "CANCELLED",
          key: "media:text:budget-denied",
          idempotencyKey: `${runId}:budget-denied`,
          input: { modelId: "gemini-text" },
          providerId: "gemini",
          costMinor: 7,
          finishedAt: new Date(),
          output: { closedBy },
        },
      });
      for (const [type, payload] of [
        ["media_intent", { key: denied.key, costMinor: 7 }],
        ["dispatch_released", { amountMinor: 7, reason: "NOT_DISPATCHED" }],
      ] as const) {
        await t.store.mutate(t.context, runId, type, async () => ({
          value: null,
          stepId: denied.id,
          payload,
        }));
      }
      const apply = (): ReturnType<typeof importLegacyTextAttempts> =>
        importLegacyTextAttempts(t.db, {
          workspaceId,
          apply: true,
          oldWritersDrained: true,
          auditId: "main-denial",
        });
      for (const report of [
        await importLegacyTextAttempts(t.db, { workspaceId }),
        await apply(),
        await apply(),
      ]) {
        expect(report.attempts).toEqual([
          {
            attemptId: denied.id,
            action: "already-imported",
            outcome: "non-dispatched",
          },
        ]);
      }
      expect(await t.db.videoRunStep.findMany({ where: { runId, key: denied.key } })).toEqual([
        denied,
      ]);
      expect(await t.db.providerRequest.count({ where: { workspaceId } })).toBe(0);
      expect(await t.db.usageReservation.count({ where: { workspaceId } })).toBe(0);
      expect(await t.db.textAttemptEvidence.count({ where: { workspaceId } })).toBe(0);
    },
  );
  it("links two refunds on an ordinary worker estimate, then accepts independent billing", async () => {
    const t = await fixture.tenant();
    const { run, step, job, native } = await workerVideo(t);
    const { workspaceId, channelId } = run;
    const fetch = native.fetch.bind(native);
    vi.spyOn(native, "fetch").mockImplementation(async (id) => ({
      ...(await fetch(id)),
      billedSeconds: null,
    }));
    await t.engine.process(job);
    await t.engine.process(job);
    const before = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } });
    const gross = before.costMinor!;
    expect(before).toMatchObject({
      state: "SUCCEEDED",
      output: { receipt: { costBasis: "RESERVATION" } },
    });
    const where = { workspaceId, correlationId: step.id };
    const posting = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(posting.actualCost?.mul(100).toNumber()).toBe(gross);
    const credits = await Promise.all(
      [1, 2].map(() => historicalCredit(t, { providerRequestId: posting.id })),
    );
    const exposure = async (): Promise<number | undefined> =>
      (await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor;
    const beforeExposure = (await exposure())!;
    expect(beforeExposure).toBeGreaterThanOrEqual(gross - 6);
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
    const options = {
      workspaceId,
      apply: true,
      oldWritersDrained: true,
      auditId: "ordinary-main-shot",
    };
    expect((await importLegacyTextAttempts(t.db, options)).unresolvedCreditIds).toEqual([]);
    expect((await importLegacyTextAttempts(t.db, options)).mediaCreditLinks).toEqual([]);
    expect(
      await t.db.usageAdjustment.count({
        where: { id: { in: credits }, providerRequestId: posting.id },
      }),
    ).toBe(2);
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      committedMinor: BigInt(gross - 6),
    });
    expect(await exposure()).toBe(beforeExposure);
    expect(
      (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
    ).toMatchObject({
      totalMinor: gross - 6,
      adjustmentNetMinor: 0,
    });
    const record = {
      costBasis: "BILLED" as const,
      costMinor: gross,
      modelId: "fixture",
      promptVersion: "fixture",
      seconds: 8,
      providerDurationSeconds: 8,
      media: null,
    };
    await captureShotReceipt(
      t.store,
      new RunPaidCalls(t.usage, t.store),
      t.context,
      before,
      record,
    );
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      committedMinor: BigInt(gross),
    });
    expect(await exposure()).toBe(beforeExposure + 6);
  });
  it("keeps a proven refund against main's unbilled video estimate", async () => {
    const t = await fixture.tenant();
    const { workspaceId, channelId } = t.run;
    const job = await refusedRoutedJob(t);
    await t.db.providerRequest.update({
      where: { id: job.requestId },
      data: {
        status: "SUCCEEDED",
        errorCode: null,
        actualCost: "0.20",
        usage: { seconds: null },
      },
    });
    const id = await historicalCredit(t, { providerRequestId: job.requestId });
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "0");
    const options = {
      workspaceId,
      apply: true,
      oldWritersDrained: true,
      auditId: "main-video-estimate",
    };
    expect((await importLegacyTextAttempts(t.db, options)).unresolvedCreditIds).toEqual([]);
    expect((await importLegacyTextAttempts(t.db, options)).mediaCreditLinks).toEqual([]);
    expect(await t.db.usageAdjustment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      providerRequestId: job.requestId,
      amountMinor: 3n,
    });
    expect(
      await t.db.providerRequest.findUniqueOrThrow({ where: { id: job.requestId } }),
    ).toMatchObject({
      actualCost: null,
    });
    expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(17);
    expect(
      (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
    ).toMatchObject({
      totalMinor: 17,
      adjustmentNetMinor: 0,
    });
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
