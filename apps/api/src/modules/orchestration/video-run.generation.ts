import { pendingCorrection } from "../usage-budget/run-pending-receipt.js";
import {
  canRollback,
  jobIdFromAdmission,
  readAdmission,
} from "../usage-budget/run-admission-state.js";
import { ProviderFailure } from "@reelforge/ai-providers";
import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { withSpan, metrics } from "@reelforge/observability";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import { DispatchAdmissionError, RunPaidCalls } from "../usage-budget/run-paid.js";
import { SETTLED_SHOTS, keyframeKey } from "../runs/run-outcomes.js";
import {
  reconcilePricedReceipt,
  recordShotArtifact,
  captureShotReceipt,
} from "../usage-budget/run-billing.js";
import {
  awaitingBilling,
  pendingShotMedia,
  withReceiptBudget,
} from "../usage-budget/run-shot-receipt.js";
import { billingHold } from "../runs/run-outcomes.js";
import { priceShot } from "../usage-budget/run-envelope.js";
import { waitForShotContinuity } from "./video-run.continuity.js";
import { RunFallback } from "./video-run.fallback.js";
import {
  ShotBillingFailure,
  ShotMediaFailure,
  UnconfiguredVideoPort,
  type MediaPortResolver,
  type VideoGenPort,
  type ShotBilling,
  type VideoReceipt,
} from "./video-run.handlers.js";

@Injectable()
export class RunGeneration {
  public provider: VideoGenPort = new UnconfiguredVideoPort();
  public fallbackProvider: VideoGenPort = new UnconfiguredVideoPort();
  public recoverKeyframe?: (context: Context, step: Step) => Promise<number | null>;
  public resolvePorts?: MediaPortResolver;
  public constructor(
    private readonly runs: RunsService,
    private readonly boundary: RunsBoundary,
    private readonly paid: RunPaidCalls,
    private readonly artifacts: RunsArtifacts,
    private readonly fallback: RunFallback,
  ) {}
  public async process(context: Context, run: Run, stepId: string): Promise<number | null> {
    const db = this.runs.store.scoped(context);
    const initial = await db.videoRunStep.findFirst({ where: { id: stepId, runId: run.id } });
    if (!initial) throw new ConflictException("Step not found in run");
    if (SETTLED_SHOTS.some((state) => state === initial.state)) {
      const pending = pendingCorrection(initial);
      if (pending) await this.capture(context, initial, pending);
      return null;
    }
    if (awaitingBilling(initial) && !pendingShotMedia(initial))
      return this.reconcileBilling(context, initial);
    if (initial.key.startsWith("media:keyframe:")) {
      if (!this.recoverKeyframe) throw new ConflictException("Keyframe recovery is unavailable");
      return this.recoverKeyframe(context, initial);
    }
    let step = initial;
    const paused = await this.waitAtBoundary(context, run, step);
    if (paused !== undefined) return paused;
    const shot = ShotSpecSchema.parse(step.input);
    const delay = await waitForShotContinuity(this.runs, context, run, step, shot.firstFrameFrom);
    if (delay !== undefined) return delay;
    const ports = this.resolvePorts
      ? await this.resolvePorts(context, run, shot, step.state !== "PENDING")
      : { primary: this.provider, fallback: this.fallbackProvider };
    if (!ports) return 12000;
    if (!step.providerJobId) {
      try {
        step = await this.submit(context, run, step, ports);
      } catch (error) {
        if (!(error instanceof ProviderFailure && error.kind === "OUTAGE" && !error.dispatched))
          throw error;
        const failed = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        await this.fallback.apply(context, run, failed, error);
        await this.runs.enqueue(context, await this.runs.store.get(context, run.id));
        return null;
      }
      if (SETTLED_SHOTS.some((state) => state === step.state)) return null;
      if (!step.providerJobId)
        return run.pauseReason?.startsWith("RECONCILE_REQUIRED") ? null : 12000;
    }
    if (pendingShotMedia(step)) {
      await this.complete(context, step, ports);
      return null;
    }
    return this.poll(context, step, ports);
  }

  private async waitAtBoundary(
    context: Context,
    run: Run,
    step: Step,
  ): Promise<number | null | undefined> {
    const db = this.runs.store.scoped(context);
    if (!step.providerJobId && step.state !== "RUNNING") {
      const stopped =
        run.state === "CANCELED" ||
        run.pauseReason === "EMERGENCY_STOP" ||
        run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
        run.pauseReason === "OPERATOR_ABANDONED";
      if (stopped || run.state !== "GENERATING") {
        const frame = await db.videoRunStep.findFirst({
          where: {
            runId: run.id,
            key: `media:${keyframeKey(ShotSpecSchema.parse(step.input))}`,
            state: "WAITING_EXTERNAL",
            providerJobId: { not: null },
          },
          orderBy: { attempt: "desc" },
        });
        if (frame && this.recoverKeyframe) {
          const delay = await this.recoverKeyframe(context, frame);
          if (delay) return delay;
        }
        return stopped ? null : 12000;
      }
      await this.boundary.check(context, run);
    }
    return undefined;
  }

  private async reconcileBilling(context: Context, step: Step): Promise<null> {
    await reconcilePricedReceipt(this.runs.store, this.paid, context, step).catch(
      (cause: unknown) => {
        throw new ShotMediaFailure(step.providerId!, step.providerJobId!, cause);
      },
    );
    const run = await this.runs.store.get(context, step.runId);
    if (run.state === "GENERATING" && !run.pauseReason) await this.runs.enqueue(context, run);
    return null;
  }

  private async poll(
    context: Context,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<number | null> {
    const status = await withSpan(
      "run.provider.poll",
      () => this.port(step, ports).poll(step.providerJobId!, this.billing(context, step)),
      "CLIENT",
    );
    if (status === "queued" || status === "running") return 12000;
    if (status !== "succeeded") {
      metrics
        .counter("run_provider_results", "Provider outcomes")
        .inc({ provider: step.providerId ?? "unconfigured", status });
      const event = await this.paid.finalizeJobFailure(
        context,
        step,
        status === "refused" ? "PROVIDER_REFUSED" : "PROVIDER_FAILED",
      );
      await this.runs.events?.publish(event);
      return null;
    }
    await this.complete(context, step, ports);
    return null;
  }
  private async submit(
    context: Context,
    run: Run,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<Step> {
    if (step.state === "RUNNING" || step.state === "WAITING_EXTERNAL")
      return this.recoverJob(context, run, step, ports);
    const shot = ShotSpecSchema.parse(step.input);
    const { step: claimed, provider: selected } = await this.claim(context, run, step, shot, ports);
    try {
      await this.boundary.check(context, await this.runs.store.get(context, run.id));
    } catch (error) {
      await this.paid.rollbackAdmission(context, claimed);
      throw error;
    }
    let result: { providerJobId: string };
    try {
      result = await this.paid.dispatch(context, claimed, () =>
        withSpan(
          "run.provider.submit",
          () => selected.submit(shot, claimed.idempotencyKey),
          "CLIENT",
        ),
      );
    } catch (error) {
      if (error instanceof DispatchAdmissionError) {
        const current = await this.runs.store
          .scoped(context)
          .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (current.idempotencyKey !== claimed.idempotencyKey) return current;
      }
      if (
        !(error instanceof ProviderFailure) ||
        error.dispatched ||
        (error.kind === "OUTAGE" && selected === ports.primary)
      )
        throw error;
      const event = await this.paid.finalizeRejected(context, claimed, error);
      await this.runs.events?.publish(event);
      return this.runs.store
        .scoped(context)
        .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    }
    await this.paid.recordJob(context, claimed, result.providerJobId);
    return this.runs.attachJob(context, claimed, result.providerJobId);
  }
  private async recoverJob(
    context: Context,
    run: Run,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<Step> {
    const admission = await readAdmission(this.runs.store.db, context, step);
    if (
      canRollback(admission) ||
      admission.evidence === "ambiguous" ||
      admission.evidence === "released-nondispatch"
    ) {
      await this.paid.rollbackAdmission(context, step);
      return this.runs.store
        .scoped(context)
        .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    }
    const jobId = jobIdFromAdmission(admission);
    if (jobId) return this.runs.attachJob(context, step, jobId);
    if (
      admission.evidence === "dispatching" &&
      admission.request &&
      Date.now() - admission.request.createdAt.getTime() < 120_000
    )
      return step;
    const recovered = await withSpan(
      "run.provider.reconcile",
      () => this.port(step, ports).reconcile(step.idempotencyKey),
      "CLIENT",
    );
    if (!recovered) {
      if (run.pauseReason?.startsWith("RECONCILE_REQUIRED")) return step;
      throw new ConflictException(`RECONCILE_REQUIRED: submission outcome unknown (${step.id})`);
    }
    return this.runs.attachJob(context, step, recovered.providerJobId);
  }

  private async claim(
    context: Context,
    run: Run,
    step: Step,
    shot: ReturnType<typeof ShotSpecSchema.parse>,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<{ step: Step; provider: VideoGenPort }> {
    const claim = await this.runs.store.mutate(
      context,
      run.id,
      "dispatch_reserved",
      async (db, current, tx) => {
        if (
          current.state !== "GENERATING" ||
          current.pauseReason === "EMERGENCY_STOP" ||
          current.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
          current.pauseReason === "OPERATOR_ABANDONED"
        )
          throw new ConflictException("Run is not generating");
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
        const { provider, amount, estimate } = priceShot(current, budget, ports, shot);
        const claimed = await db.videoRunStep.updateMany({
          where: { id: step.id, state: "PENDING", idempotencyKey: step.idempotencyKey },
          data: {
            state: "RUNNING",
            startedAt: new Date(),
            costMinor: amount,
            providerId: provider.providerId,
            output: withReceiptBudget(json({}), {
              admittedMinor: amount,
              bufferMinor: amount - estimate,
              estimateMinor: estimate,
            }),
          },
        });
        if (!claimed.count) throw new ConflictException("Step already claimed");
        await db.budgetEnvelope.updateMany({
          where: { id: budget.id, revision: budget.revision },
          data: { reservedMinor: budget.reservedMinor + amount, revision: budget.revision + 1 },
        });
        const updated = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        await this.paid.reserve(context, current, updated, amount, tx);
        if (provider.modelId)
          await tx.providerRequest.updateMany({
            where: { workspaceId: context.workspaceId, correlationId: step.id },
            data: { capabilityId: provider.modelId },
          });
        return {
          value: { step: updated, provider },
          payload: { amountMinor: amount },
          stepId: step.id,
        };
      },
    );
    await this.runs.events?.publish(claim.event);
    return claim.value;
  }
  private port(step: Step, ports: { primary: VideoGenPort; fallback: VideoGenPort }): VideoGenPort {
    const registry = new Map(
      [ports.primary, ports.fallback].map((port) => [port.providerId, port]),
    );
    const port = step.providerId ? registry.get(step.providerId) : undefined;
    if (!port) throw new ConflictException("RECONCILE_REQUIRED: stored provider is unavailable");
    return port;
  }
  private recordSuccess(cost: number, step: Step, started: number): void {
    metrics
      .counter("run_provider_results", "Provider outcomes")
      .inc({ provider: step.providerId ?? "unconfigured", status: "succeeded" });
    metrics
      .counter("run_provider_cost_minor", "Provider cost in cents")
      .inc({ provider: step.providerId ?? "unconfigured" }, cost);
    metrics
      .histogram("run_provider_latency_ms", "Provider latency")
      .observe({ provider: step.providerId ?? "unconfigured" }, Date.now() - started);
  }
  private capture(context: Context, step: Step, receipt: VideoReceipt): Promise<Step> {
    return captureShotReceipt(this.runs.store, this.paid, context, step, receipt).catch(
      (cause: unknown) => {
        throw new ShotBillingFailure(cause, {
          providerId: step.providerId,
          jobId: step.providerJobId,
          receipt,
        });
      },
    );
  }
  private billing(context: Context, step: Step): ShotBilling {
    return {
      shot: ShotSpecSchema.parse(step.input),
      record: async (receipt): Promise<void> => {
        await this.capture(context, step, receipt);
      },
    };
  }
  private async complete(
    context: Context,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<void> {
    const started = step.startedAt?.getTime() ?? Date.now();
    const port = this.port(step, ports);
    const recovering = !!pendingShotMedia(step);
    const billing = this.billing(context, step);
    if (!pendingShotMedia(step)?.pendingMedia && port.collectReceipt) {
      const receipt = await port.collectReceipt(step.providerJobId!, billing.shot, billing);
      step = await this.capture(context, step, receipt);
      if (step.state === "SUCCEEDED" || (awaitingBilling(step) && !pendingShotMedia(step))) return;
    }
    const body = await withSpan(
      "run.provider.fetch",
      () =>
        port.fetch(step.providerJobId!, pendingShotMedia(step)?.pendingMedia ?? undefined, billing),
      "CLIENT",
    );
    const artifact = await this.artifacts
      .put(context, "clips", body, "video/mp4")
      .catch((cause: unknown) => {
        throw new ShotMediaFailure(port.providerId, step.providerJobId!, cause);
      });
    const result = await recordShotArtifact(
      this.runs.store,
      this.paid,
      context,
      step,
      artifact,
    ).catch((cause: unknown) => {
      throw new ShotMediaFailure(port.providerId, step.providerJobId!, cause);
    });
    await this.runs.events?.publish(result.event);
    if (result.event.type === "reconcile_required") {
      if (!recovering)
        throw new ShotMediaFailure(
          port.providerId,
          step.providerJobId!,
          new ConflictException(billingHold(step.id)),
        );
      await this.reconcileBilling(context, step);
    }
    if (result.value !== null) {
      this.recordSuccess(result.value, step, started);
    }
  }
}
