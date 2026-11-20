import type { Prisma } from "@reelforge/database";
import { describe, expect, it, vi } from "vitest";
import { ADMISSION_ORDERING, OUTCOME_UNKNOWN } from "../usage-budget/run-admission-state.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import type { Run, Step } from "./runs.types.js";
import { generating, runsFixture, type Tenant } from "./runs.fixture.js";

const amountMinor = 10;

async function claimShot(t: Tenant, run: Run, key = "shot-0"): Promise<Step> {
  const { context } = t;
  const paid = new RunPaidCalls(t.usage, t.store);

  const { value: step } = await t.store.mutate(
    context,
    run.id,
    "dispatch_reserved",
    async (db, _, tx) => {
      const pending = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key },
      });
      await db.videoRunStep.updateMany({
        where: { id: pending.id },
        data: {
          state: "RUNNING",
          costMinor: amountMinor,
          providerId: t.generation.provider.providerId,
        },
      });
      const claimed = await db.videoRunStep.findFirstOrThrow({ where: { id: pending.id } });
      await paid.reserve(context, run, claimed, amountMinor, tx);
      const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
      await db.budgetEnvelope.updateMany({
        where: { runId: run.id },
        data: { reservedMinor: budget.reservedMinor + amountMinor },
      });
      return { value: claimed, payload: {} };
    },
  );
  return step;
}

describe.skipIf(!process.env.DATABASE_URL)("shot admission recovery", () => {
  const fixture = runsFixture();

  it.each(["tagged", "legacy", "missing"] as const)(
    "recovers a RUNNING shot with %s admission evidence",
    async (evidence) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const { context } = t;
      const step = await claimShot(t, run);
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
        const reconcile = vi.spyOn(t.generation.provider, "reconcile").mockResolvedValue(null);
        await expect(t.engine.process(job)).resolves.toBeNull();
        expect(reconcile).toHaveBeenCalledExactlyOnceWith(step.idempotencyKey);
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

  it.each(["legacy", "missing"] as const)(
    "retains %s claims when run controls precede recovery",
    async (evidence) => {
      const t = await fixture.tenant();
      const run = await generating(t);
      const step = await claimShot(t, run);
      const { context } = t;
      const where = { workspaceId: context.workspaceId, correlationId: step.id };
      if (evidence === "legacy")
        await t.db.providerRequest.updateMany({
          where,
          data: { responseMetadata: { dispatched: false } },
        });
      else await t.db.providerRequest.deleteMany({ where });

      const assertHeld = async (): Promise<void> => {
        expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
          status: "RESERVED",
          committedMinor: null,
        });
        expect(
          await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
        ).toMatchObject({ reservedMinor: amountMinor, spentMinor: 0 });
        expect(
          await t.db.videoRunStep.findMany({ where: { runId: run.id, key: step.key } }),
        ).toEqual([
          expect.objectContaining({
            state: "RUNNING",
            idempotencyKey: step.idempotencyKey,
            providerJobId: null,
          }),
        ]);
        expect((await t.db.providerRequest.findFirst({ where }))?.actualCost ?? null).toBeNull();
        expect((await t.store.get(context, run.id)).pauseReason).toContain(step.id);
      };
      // Enter abandon's eligible state with the original evidence still intact.
      await t.db.videoRun.updateMany({
        where: { id: run.id },
        data: { pauseReason: "OPERATOR_ABANDONED" },
      });
      await expect(t.control.abandon(context, run.id, step.id)).rejects.toThrow("Reconcile");
      await assertHeld();
      // Cancel must discover the evidence independently, even before any hold is recorded.
      await t.db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: null } });
      await t.control.cancel(context, run.id);
      expect((await t.store.get(context, run.id)).state).toBe("CANCELED");
      await assertHeld();
      await expect(t.control.abandon(context, run.id, step.id)).rejects.toThrow("Reconcile");
      await assertHeld();
    },
  );

  it("moves a resolved hold to a sibling with ambiguous evidence and blocks resume and retry", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const safe = await claimShot(t, run);
    const held = await claimShot(t, run, "shot-1");
    await t.db.providerRequest.deleteMany({
      where: { workspaceId: run.workspaceId, correlationId: held.id },
    });
    const db = t.store.scoped(t.context);
    await db.videoRun.updateMany({
      where: { id: run.id },
      data: { pauseReason: `RECONCILE_REQUIRED (${safe.id})` },
    });
    const paid = new RunPaidCalls(t.usage, t.store);
    await paid.rollbackAdmission(t.context, safe);
    expect((await t.store.get(t.context, run.id)).pauseReason).toContain(held.id);

    const other = await claimShot(t, run, "shot-2");
    await t.control.abandon(t.context, run.id, other.id);
    expect((await t.store.get(t.context, run.id)).pauseReason).toContain(held.id);
    await db.videoRun.updateMany({
      where: { id: run.id },
      data: { state: "PAUSED_BUDGET", pauseReason: "BUDGET_CAP" },
    });
    await expect(t.control.resume(t.context, run.id)).rejects.toThrow("Reconcile");
    expect((await t.store.get(t.context, run.id)).pauseReason).toContain(held.id);
    expect(await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: amountMinor,
      spentMinor: 0,
    });
  });

  it("refuses dispatch without a reservation and returns the never-dispatched shot to PENDING", async () => {
    const t = await fixture.tenant();
    const run = await generating(t);
    const step = await claimShot(t, run);
    const where = { workspaceId: run.workspaceId, correlationId: step.id };
    await t.db.providerRequest.deleteMany({ where });
    await t.db.usageReservation.deleteMany({ where });
    const submit = vi.fn();
    await expect(
      new RunPaidCalls(t.usage, t.store).dispatch(t.context, step, submit),
    ).rejects.toThrow("Paid dispatch reservation is inactive");
    expect(submit).not.toHaveBeenCalled();
    expect(await t.db.videoRunStep.findFirstOrThrow({ where: { id: step.id } })).toMatchObject({
      state: "PENDING",
      costMinor: null,
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 0,
    });
    expect(await t.db.providerRequest.count({ where })).toBe(0);
    expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
  });
});
