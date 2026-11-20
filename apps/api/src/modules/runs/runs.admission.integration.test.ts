import type { Prisma } from "@reelforge/database";
import { describe, expect, it, vi } from "vitest";
import { ADMISSION_ORDERING } from "../usage-budget/run-paid-admission.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { OUTCOME_UNKNOWN } from "./run-outcomes.js";
import { generating, runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("shot admission recovery", () => {
  const fixture = runsFixture();

  it.each(["tagged", "legacy", "missing"] as const)(
    "recovers a RUNNING shot with %s admission evidence",
    async (evidence) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const { context } = t;
      const paid = new RunPaidCalls(t.usage, t.store);
      const amountMinor = 10;
      const { value: step } = await t.store.mutate(
        context,
        run.id,
        "dispatch_reserved",
        async (db, _, tx) => {
          const pending = await db.videoRunStep.findFirstOrThrow({
            where: { runId: run.id, key: "shot-0" },
          });
          await db.videoRunStep.updateMany({
            where: { id: pending.id },
            data: { state: "RUNNING", costMinor: amountMinor },
          });
          const claimed = await db.videoRunStep.findFirstOrThrow({ where: { id: pending.id } });
          await paid.reserve(context, run, claimed, amountMinor, tx);
          await db.budgetEnvelope.updateMany({
            where: { runId: run.id },
            data: { reservedMinor: amountMinor },
          });
          return { value: claimed, payload: {} };
        },
      );
      const where = { workspaceId: context.workspaceId, correlationId: step.id };
      const request = (): Promise<Prisma.ProviderRequestGetPayload<object>> =>
        t.db.providerRequest.findFirstOrThrow({ where });
      expect(await request()).toMatchObject({
        errorCode: "PENDING",
        responseMetadata: { admissionOrdering: ADMISSION_ORDERING },
      });
      if (evidence === "legacy")
        await t.db.providerRequest.updateMany({
          where,
          data: { responseMetadata: { dispatched: false, costKnown: false } },
        });
      if (evidence === "missing") await t.db.providerRequest.deleteMany({ where });

      const submit = vi.spyOn(t.generation.provider, "submit");
      const job = t.runs.job(context, run.id, step.id);
      const tagged = evidence === "tagged";
      if (tagged) {
        await expect(t.engine.process(job)).resolves.toBe(12000);
        const rolledBack = await request();
        expect(rolledBack).toMatchObject({
          errorCode: "ADMISSION_ROLLED_BACK",
          responseMetadata: {
            admissionOrdering: ADMISSION_ORDERING,
            dispatched: false,
            costKnown: true,
          },
        });
        expect(rolledBack.actualCost?.toNumber()).toBe(0);
      } else {
        await expect(t.engine.process(job)).rejects.toThrow("RECONCILE_REQUIRED");
        expect(await request()).toMatchObject({ errorCode: OUTCOME_UNKNOWN, actualCost: null });
        await expect(t.control.abandon(context, run.id, step.id)).rejects.toThrow("Reconcile");
        expect(await t.store.get(context, run.id)).toMatchObject({
          state: "GENERATING",
          pauseReason: expect.stringContaining(step.id),
        });
      }
      expect(submit).not.toHaveBeenCalled();

      const db = t.store.scoped(context);
      const recovered = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      expect(recovered).toMatchObject({
        state: tagged ? "PENDING" : "RUNNING",
        costMinor: tagged ? null : amountMinor,
        providerJobId: null,
      });
      expect(recovered.idempotencyKey === step.idempotencyKey).toBe(!tagged);
      expect(await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
        reservedMinor: tagged ? 0 : amountMinor,
        spentMinor: 0,
      });
      expect(
        await t.db.usageReservation.findFirstOrThrow({
          where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
        }),
      ).toMatchObject({ status: tagged ? "RELEASED" : "RESERVED", committedMinor: null });
    },
  );
});
