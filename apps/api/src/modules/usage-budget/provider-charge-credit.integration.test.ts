import type { ShotBilling, VideoGenPort } from "../orchestration/video-run.handlers.js";
import { refusedRoutedJob } from "./routed-refusal.fixture.js";
import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { generating, runsFixture } from "../runs/runs.fixture.js";
import { unresolvedLegacyCredits } from "./legacy-text-import-credits.js";

describe.skipIf(!process.env.DATABASE_URL)(
  "owner corrections to failed estimated media charges",
  () => {
    const fixture = runsFixture();
    it("credits the original committed refusal once across reservation, envelope and exposure", async () => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const { workspaceId, channelId } = run;
      const source = await t.db.videoRunStep.findFirstOrThrow({
        where: { workspaceId, runId: run.id, key: "shot-0" },
      });
      const job = t.runs.job(t.context, run.id, source.id);
      let callback: ShotBilling["record"] | undefined;
      const port: VideoGenPort = t.generation.provider;
      vi.spyOn(port, "poll")
        .mockImplementationOnce(async (_id, billing) => {
          callback = billing?.record;
          return "running";
        })
        .mockResolvedValue("refused");
      await t.engine.process(job);
      await t.engine.process(job);
      const where = { workspaceId, correlationId: source.id };
      const request = await t.db.providerRequest.findFirstOrThrow({ where });
      expect(request).toMatchObject({
        errorCode: "PROVIDER_JOB_FAILED",
        responseMetadata: { dispatched: true },
      });
      const reservation = await t.db.usageReservation.findFirstOrThrow({ where });
      expect(reservation.status).toBe("COMMITTED");
      const original = Number(reservation.committedMinor);
      expect(original).toBeGreaterThan(3);
      const credit = {
        kind: "CREDIT",
        providerRequestId: request.id,
        operationKey: "refusal-refund",
        amountMinor: 3,
        reason: "invoice refund",
      };
      const first = await t.usage.createAdjustment(t.context, credit);
      expect((await t.usage.createAdjustment(t.context, credit)).adjustmentId).toBe(
        first.adjustmentId,
      );
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        committedMinor: BigInt(original - 3),
      });
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject(
        { costMinor: original - 3 },
      );
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ spentMinor: original - 3 });
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(
        original - 3,
      );
      expect(
        (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
      ).toMatchObject({ committedMinor: original - 3, adjustmentNetMinor: 0 });
      await expect(
        t.usage.createAdjustment(t.context, {
          ...credit,
          amountMinor: original,
          operationKey: "excess",
        }),
      ).rejects.toThrow();
      const failed = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } });
      expect(failed.state).toBe("SKIPPED");
      expect(callback).toBeTypeOf("function");
      const lateBill = {
        costBasis: "BILLED" as const,
        costMinor: original + 3,
        modelId: "fixture",
        promptVersion: "fixture",
        seconds: 7,
        providerDurationSeconds: 7,
        media: null,
      };
      const state = await t.store.get(t.context, run.id);
      await callback!(lateBill);
      await callback!(lateBill);
      await callback!({ ...lateBill, costMinor: original - 1 });
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        committedMinor: BigInt(lateBill.costMinor),
      });
      expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject(
        {
          state: "SKIPPED",
          costMinor: lateBill.costMinor,
          error: failed.error,
        },
      );
      expect(await t.store.get(t.context, run.id)).toMatchObject({
        state: state.state,
        pauseReason: state.pauseReason,
      });
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({
        spentMinor: lateBill.costMinor,
      });
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(
        lateBill.costMinor,
      );
      expect(
        (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
      ).toMatchObject({
        totalMinor: lateBill.costMinor,
        adjustmentNetMinor: 0,
      });
    });
    it.each([4, 7, 23])(
      "replays the refunded routed refusal at 7 cents and settles a %i cent bill",
      async (cents) => {
        const t = await fixture.tenant();
        const { workspaceId, channelId } = t.run;
        const job = await refusedRoutedJob(t);
        const where = { workspaceId, correlationId: job.correlationId };
        const posting = (): Promise<{ committedMinor: bigint | null }> =>
          t.db.usageReservation.findFirstOrThrow({ where });
        const consumed = async (): Promise<number | undefined> =>
          (await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor;
        expect((await posting()).committedMinor).toBe(20n);
        await t.usage.createAdjustment(t.context, {
          kind: "CREDIT",
          providerRequestId: job.requestId,
          operationKey: "routed-refund",
          amountMinor: 13,
          reason: "invoice refund",
        });
        await job.replay();
        expect((await posting()).committedMinor).toBe(7n);
        expect(await consumed()).toBe(7);
        await job.bill(cents);
        await job.bill(cents);
        expect((await posting()).committedMinor).toBe(BigInt(cents));
        expect(await consumed()).toBe(cents);
        expect(
          (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
        ).toMatchObject({
          committedMinor: cents,
          totalMinor: cents,
          adjustmentNetMinor: 0,
        });
        await t.db.usageBudget.updateMany({
          where: { workspaceId },
          data: { dailyLimitMinor: BigInt(cents) },
        });
        await expect(
          t.usage.reserve(workspaceId, {
            channelId,
            category: "VIDEO_MEDIA",
            currency: "USD",
            idempotencyKey: "competing-after-final",
            amountMinor: 1,
          }),
        ).rejects.toMatchObject({
          code: "BUDGET_EXHAUSTED",
          details: { consumedMinor: cents },
        });
      },
    );
    it("settles routed billing before a failed download and rejects unordered downward amounts", async () => {
      const t = await fixture.tenant();
      const { workspaceId } = t.run;
      const job = await refusedRoutedJob(t);
      await t.usage.createAdjustment(t.context, {
        kind: "CREDIT",
        providerRequestId: job.requestId,
        operationKey: "routed-refund",
        amountMinor: 13,
        reason: "invoice refund",
      });
      const where = { workspaceId, correlationId: job.correlationId };
      await expect(job.reconcile(23, true)).rejects.toThrow("media download failed");
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        committedMinor: 23n,
      });
      await job.reconcile(23);
      await job.reconcile(4);
      expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
        committedMinor: 23n,
      });
      const posting = await t.db.providerRequest.findFirstOrThrow({ where });
      expect(posting.actualCost?.toString()).toBe("0.23");
      expect(posting.usage).toEqual({ seconds: 23 });
      expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(23);
    });
    it("keeps an expired unresolved dispatch charged against competing admission", async () => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const { workspaceId, channelId } = run;
      const source = await t.db.videoRunStep.findFirstOrThrow({
        where: { workspaceId, runId: run.id, key: "shot-0" },
      });
      vi.spyOn(t.generation.provider, "submit").mockRejectedValueOnce(
        new Error("response lost after POST"),
      );
      await expect(t.engine.process(t.runs.job(t.context, run.id, source.id))).rejects.toThrow(
        "RECONCILE_REQUIRED",
      );
      const where = { workspaceId, correlationId: source.id };
      const request = await t.db.providerRequest.findFirstOrThrow({ where });
      expect(request.errorCode).toBe("VIDEO_RUN_OUTCOME_UNKNOWN");
      const amountMinor = request.estimatedCost!.mul(100).toNumber();
      await t.db.usageReservation.updateMany({ where, data: { expiresAt: new Date(0) } });
      await t.usage.sweepExpiredReservations(new Date(), workspaceId);
      await t.db.usageBudget.updateMany({
        where: { workspaceId },
        data: { dailyLimitMinor: BigInt(amountMinor) },
      });
      await expect(
        t.usage.createAdjustment(t.context, {
          kind: "CREDIT",
          providerRequestId: request.id,
          amountMinor,
          operationKey: "unresolved",
          reason: "pending refund",
        }),
      ).rejects.toThrow("remaining");
      expect(await t.db.usageAdjustment.count({ where: { workspaceId } })).toBe(0);
      await expect(
        t.usage.reserve(workspaceId, {
          channelId,
          category: "VIDEO_MEDIA",
          currency: "USD",
          idempotencyKey: "competing",
          amountMinor: 1,
        }),
      ).rejects.toMatchObject({
        code: "BUDGET_EXHAUSTED",
        details: { consumedMinor: amountMinor },
      });
    });
    it.each(["video", "audio"])(
      "links a %s correction once and applies it to the original charge",
      async (capabilityId) => {
        const t = await fixture.tenant();
        const { workspaceId, channelId } = t.run;
        const charge = await t.db.providerRequest.create({
          data: {
            workspaceId,
            channelId,
            correlationId: randomUUID(),
            providerId: "fixture",
            capabilityId,
            status: "FAILED",
            errorCode: "REFUSED",
            estimatedCost: "0.20",
            currency: "USD",
          },
        });
        const input = {
          kind: "CREDIT",
          providerRequestId: charge.id,
          operationKey: "invoice-1",
          amountMinor: 13,
          reason: "provider invoice correction",
        };
        await expect(
          t.usage.createAdjustment({ ...t.context, role: "EDITOR" }, input),
        ).rejects.toBeInstanceOf(ForbiddenException);
        const result = await t.usage.createAdjustment(t.context, input);
        expect((await t.usage.createAdjustment(t.context, input)).adjustmentId).toBe(
          result.adjustmentId,
        );
        await expect(
          t.usage.createAdjustment(t.context, { ...input, operationKey: "excess", amountMinor: 8 }),
        ).rejects.toThrow("remaining");
        expect(
          await t.db.usageAdjustment.findUniqueOrThrow({ where: { id: result.adjustmentId } }),
        ).toMatchObject({
          providerRequestId: charge.id,
          textAttemptId: null,
          channelId,
          currency: "USD",
          amountMinor: 13n,
        });
        expect(
          await t.db.usageAuditRecord.findFirstOrThrow({
            where: { adjustmentId: result.adjustmentId },
          }),
        ).toMatchObject({
          actorUserId: t.context.userId,
          after: { adjustment: { providerRequestId: charge.id } },
        });
        expect(
          await t.db.$transaction((tx) => unresolvedLegacyCredits(tx, workspaceId, false)),
        ).toEqual([]);
        expect(
          (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
        ).toMatchObject({ failedEstimatedMinor: 7, adjustmentNetMinor: 0, totalMinor: 7 });
        expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(7);
        await t.db.providerRequest.update({
          where: { id: charge.id },
          data: { actualCost: "0.04" },
        });
        expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(4);
      },
    );
  },
);
