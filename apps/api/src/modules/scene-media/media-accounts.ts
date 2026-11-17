import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  BudgetExhaustedError,
  BudgetUnresolvableError,
} from "../usage-budget/usage-budget.types.js";
import { envelopeRoom } from "../usage-budget/run-envelope.js";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import { MediaAccess } from "./media-access.js";
@Injectable()
export class MediaAccounts {
  public constructor(private readonly access: MediaAccess) {}
  public async begin(
    context: Context,
    run: Run,
    key: string,
    input: unknown,
    cost: number,
    modelId: string,
  ): Promise<Step> {
    await this.access.boundary.check(context, run);
    const result = await this.access.runs.store.mutate(
      context,
      run.id,
      "media_intent",
      async (db) => {
        const previous = await db.videoRunStep.findFirst({ where: { runId: run.id, key } });
        if (previous) return { value: previous, payload: { replay: true } };
        const steps = await db.videoRunStep.findMany({ where: { runId: run.id } });
        const pending = steps
          .filter((s) => !["SKIPPED", "CANCELLED"].includes(s.state))
          .reduce((sum, s) => sum + (s.costMinor ?? 0), 0);
        if (pending + cost > 800) throw new ConflictException("BUDGET_CAP");
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
        if (budget && !envelopeRoom(budget, cost)) throw new ConflictException("BUDGET_CAP");
        const step = await db.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: run.id,
            key,
            attempt: 1,
            state: "RUNNING",
            costMinor: cost,
            providerId: "gemini",
            idempotencyKey: `${run.id}:${key}:1`,
            input: json({ spec: input, modelId }),
            startedAt: new Date(),
          },
        });
        if (budget)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id, revision: budget.revision },
            data: { reservedMinor: budget.reservedMinor + cost, revision: budget.revision + 1 },
          });
        return { value: step, payload: { key, costMinor: cost }, stepId: step.id };
      },
    );
    await this.access.runs.events?.publish(result.event);
    if ((result.event.payload as { replay?: boolean }).replay)
      throw new ConflictException("RECONCILE_REQUIRED: media intent already claimed");
    return result.value;
  }
  public async reserve(context: Context, run: Run, step: Step, modelId: string): Promise<void> {
    await this.access.paid.reserve(context, run, step, step.costMinor ?? 0);
    await this.access.runs.store.db.providerRequest.updateMany({
      where: { workspaceId: context.workspaceId, correlationId: step.id },
      data: {
        providerId: "gemini",
        capabilityId: modelId,
        dispatchedPrompt: "V5 media job; immutable input on VideoRunStep",
      },
    });
  }
  public async prepare(context: Context, run: Run, step: Step, modelId: string): Promise<void> {
    try {
      await this.reserve(context, run, step, modelId);
    } catch (error) {
      const ledger = await this.reservationEvidence(context, step);
      const denied =
        error instanceof BudgetExhaustedError ||
        error instanceof BudgetUnresolvableError ||
        (error instanceof ServiceUnavailableException &&
          error.message === "Budget policy unavailable");
      if (denied && !ledger.reservation && !ledger.request) {
        await this.closeUndispatched(context, step);
        throw error;
      }
      // A timeout, replay or partial ledger write is not proof of non-reservation.
      await this.reconcilePending(context, step);
    }
    try {
      await this.access.boundary.check(context, await this.access.runs.store.get(context, run.id));
    } catch (error) {
      // reserve resolved successfully and submit has not been invoked.
      await this.cancelUndispatched(context, step);
      throw error;
    }
  }
  public async reconcilePending(context: Context, step: Step): Promise<never> {
    const ledger = await this.reservationEvidence(context, step);
    await this.access.runs.store.scoped(context).videoRunStep.updateMany({
      where: { id: step.id, state: "RUNNING", providerJobId: null },
      data: {
        output: json({
          reconciliationRequired: {
            idempotencyKey: `m08:${step.idempotencyKey}`,
            reservationId: ledger.reservation?.id ?? null,
            requestId: ledger.request?.id ?? null,
          },
        }),
      },
    });
    throw new ConflictException(
      "RECONCILE_REQUIRED: media paid intent requires ledger reconciliation",
    );
  }
  private async reservationEvidence(
    context: Context,
    step: Step,
  ): Promise<{
    reservation: { id: string } | null;
    request: { id: string } | null;
  }> {
    const db = this.access.runs.store.db;
    const [reservation, request] = await Promise.all([
      db.usageReservation.findFirst({
        where: {
          workspaceId: context.workspaceId,
          idempotencyKey: `m08:${step.idempotencyKey}`,
        },
        select: { id: true },
      }),
      db.providerRequest.findFirst({
        where: {
          workspaceId: context.workspaceId,
          correlationId: step.id,
        },
        select: { id: true },
      }),
    ]);
    return { reservation, request };
  }
  /** A confirmed non-dispatch refunds both ledgers and closes the attempt. */
  public async cancelUndispatched(context: Context, step: Step): Promise<void> {
    const current = await this.access.runs.store
      .scoped(context)
      .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    if (current.state === "CANCELLED") return;
    if (current.state !== "RUNNING" || current.providerJobId)
      throw new ConflictException("Dispatched media cannot be cancelled as unsubmitted");
    await this.access.paid.finish(context, step, false, 0);
    await this.closeUndispatched(context, step);
  }
  private async closeUndispatched(context: Context, step: Step): Promise<void> {
    const result = await this.access.runs.store.mutate(
      context,
      step.runId,
      "media_not_dispatched",
      async (db) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (current.state === "CANCELLED") return { value: null, payload: { replay: true } };
        if (current.providerJobId || current.state !== "RUNNING")
          throw new ConflictException("Dispatched media cannot be cancelled as unsubmitted");
        const closed = await db.videoRunStep.updateMany({
          where: { id: step.id, state: "RUNNING", providerJobId: null },
          data: { state: "CANCELLED", finishedAt: new Date() },
        });
        if (closed.count !== 1) throw new ConflictException("Media attempt changed");
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: step.runId } });
        if (budget)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id, revision: budget.revision },
            data: {
              reservedMinor: budget.reservedMinor - (current.costMinor ?? 0),
              revision: budget.revision + 1,
            },
          });
        return { value: null, payload: { refundedMinor: step.costMinor }, stepId: step.id };
      },
    );
    await this.access.runs.events?.publish(result.event);
  }
  public async complete(context: Context, step: Step, output: unknown): Promise<void> {
    await this.access.paid.finish(context, step, true, step.costMinor ?? 0);
    const result = await this.access.runs.store.mutate(
      context,
      step.runId,
      "media_completed",
      async (db) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (current.state === "SUCCEEDED") return { value: null, payload: { replay: true } };
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: step.runId } });
        if (budget)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id, revision: budget.revision },
            data: {
              reservedMinor: budget.reservedMinor - (step.costMinor ?? 0),
              spentMinor: budget.spentMinor + (step.costMinor ?? 0),
              revision: budget.revision + 1,
            },
          });
        await db.videoRunStep.updateMany({
          where: { id: step.id },
          data: {
            state: "SUCCEEDED",
            finishedAt: new Date(),
            output: json({ result: output, budgetAccounted: !!budget }),
          },
        });
        return { value: null, payload: { costMinor: step.costMinor }, stepId: step.id };
      },
    );
    await this.access.runs.events?.publish(result.event);
  }
  public async sync(context: Context, run: Run): Promise<void> {
    const result = await this.access.runs.store.mutate(
      context,
      run.id,
      "media_budget_reconciled",
      async (db) => {
        const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
        if (!budget) return { value: null, payload: { pending: true } };
        const steps = await db.videoRunStep.findMany({
          where: { runId: run.id, key: { startsWith: "media:" }, state: "SUCCEEDED" },
        });
        const unaccounted = steps.filter((s) => !this.accounted(s.output));
        const cost = unaccounted.reduce((sum, s) => sum + (s.costMinor ?? 0), 0);
        if (!envelopeRoom(budget, cost)) throw new ConflictException("BUDGET_CAP");
        for (const step of unaccounted)
          await db.videoRunStep.updateMany({
            where: { id: step.id },
            data: { output: json({ ...this.record(step.output), budgetAccounted: true }) },
          });
        if (cost)
          await db.budgetEnvelope.updateMany({
            where: { id: budget.id },
            data: { spentMinor: budget.spentMinor + cost, revision: budget.revision + 1 },
          });
        return { value: null, payload: { costMinor: cost } };
      },
    );
    await this.access.runs.events?.publish(result.event);
  }
  private record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private accounted(value: unknown): boolean {
    return this.record(value).budgetAccounted === true;
  }
}
