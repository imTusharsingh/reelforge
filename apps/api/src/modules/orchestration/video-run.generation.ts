import { ProviderFailure } from "@reelforge/ai-providers";
import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { withSpan, metrics } from "@reelforge/observability";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { DISPATCHING, SETTLED_SHOTS, failSettledGeneration } from "../runs/run-outcomes.js";
import { envelopeRoom } from "../usage-budget/run-envelope.js";
import { waitForShotContinuity } from "./video-run.continuity.js";
import { RunFallback } from "./video-run.fallback.js";
import {
  UnconfiguredVideoPort,
  type MediaPortResolver,
  type VideoGenPort,
} from "./video-run.handlers.js";

@Injectable()
export class RunGeneration {
  public provider: VideoGenPort = new UnconfiguredVideoPort();
  public fallbackProvider: VideoGenPort = new UnconfiguredVideoPort();
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
    if (SETTLED_SHOTS.some((state) => state === initial.state)) return null;
    let step = initial;
    if (!step.providerJobId) {
      if (
        run.state === "CANCELED" ||
        run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
        run.pauseReason === "OPERATOR_ABANDONED"
      )
        return null;
      if (run.state !== "GENERATING") return 12000;
    }
    await this.boundary.check(context, run);
    const shot = ShotSpecSchema.parse(step.input);
    const delay = await waitForShotContinuity(this.runs, context, run, step, shot.firstFrameFrom);
    if (delay !== undefined) return delay;
    const ports = this.resolvePorts
      ? await this.resolvePorts(context, run, shot)
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
      if (step.state === "FAILED") return null;
      if (!step.providerJobId) return 12000;
    }
    return this.poll(context, step, ports);
  }

  private async poll(
    context: Context,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<number | null> {
    const status = await withSpan(
      "run.provider.poll",
      () => this.port(step, ports).poll(step.providerJobId!),
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
    const envelope = await this.runs.store
      .scoped(context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    const selected = envelope.route === "FALLBACK" ? ports.fallback : ports.primary;
    selected.assertKey?.();
    const amount = selected.estimate(shot, envelope.route === "FALLBACK");
    await this.claim(context, run, step, amount, selected.providerId);
    try {
      await this.paid.reserve(context, run, step, amount);
    } catch (error) {
      // M18 refused before dispatch. Do not send this shot through provider reconciliation.
      if (!(await this.hasPaidAttempt(context, step)))
        await this.releaseClaim(context, run, step, amount);
      throw error;
    }
    await this.runs.store.db.providerRequest.updateMany({
      where: { workspaceId: context.workspaceId, correlationId: step.id },
      data: {
        providerId: selected.providerId,
        capabilityId: selected.modelId ?? "video",
        dispatchedPrompt: "V5 immutable ShotSpec on VideoRunStep",
      },
    });
    const currentRun = await this.runs.store.get(context, run.id);
    if (currentRun.state !== "CANCELED") await this.boundary.check(context, currentRun);
    let result: { providerJobId: string };
    try {
      result = await this.paid.dispatch(context, step, () =>
        withSpan("run.provider.submit", () => selected.submit(shot, step.idempotencyKey), "CLIENT"),
      );
    } catch (error) {
      if (
        !(error instanceof ProviderFailure) ||
        error.dispatched ||
        (error.kind === "OUTAGE" && selected === ports.primary)
      )
        throw error;
      const event = await this.paid.finalizeRejected(context, step, error);
      await this.runs.events?.publish(event);
      return this.runs.store
        .scoped(context)
        .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    }
    return this.saveJob(context, run, step, result.providerJobId);
  }
  private async recoverJob(
    context: Context,
    run: Run,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<Step> {
    if (!(await this.hasPaidAttempt(context, step)))
      throw new ConflictException("Paid reservation missing; no submission to reconcile");
    const active = await this.runs.store.db.providerRequest.findFirst({
      where: { workspaceId: context.workspaceId, correlationId: step.id, errorCode: DISPATCHING },
    });
    if (active && Date.now() - active.createdAt.getTime() < 120_000) return step;
    const recovered = await withSpan(
      "run.provider.reconcile",
      () => this.port(step, ports).reconcile(step.idempotencyKey),
      "CLIENT",
    );
    if (!recovered)
      throw new ConflictException(`RECONCILE_REQUIRED: submission outcome unknown (${step.id})`);
    return this.saveJob(context, run, step, recovered.providerJobId);
  }

  private async claim(
    context: Context,
    run: Run,
    step: Step,
    amount: number,
    providerId: string,
  ): Promise<void> {
    const claim = await this.runs.store.mutate(
      context,
      run.id,
      "dispatch_reserved",
      async (db, current) => {
        if (current.state !== "GENERATING") throw new ConflictException("Run is not generating");
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
        if (!envelopeRoom(budget, amount))
          throw new ConflictException({ code: "BUDGET_CAP", message: "Envelope exhausted" });
        const claimed = await db.videoRunStep.updateMany({
          where: { id: step.id, state: "PENDING" },
          data: {
            state: "RUNNING",
            startedAt: new Date(),
            costMinor: amount,
            providerId,
          },
        });
        if (!claimed.count) throw new ConflictException("Step already claimed");
        await db.budgetEnvelope.updateMany({
          where: { id: budget.id, revision: budget.revision },
          data: { reservedMinor: budget.reservedMinor + amount, revision: budget.revision + 1 },
        });
        return { value: null, payload: { amountMinor: amount }, stepId: step.id };
      },
    );
    await this.runs.events?.publish(claim.event);
  }
  private async hasPaidAttempt(context: Context, step: Step): Promise<boolean> {
    const [reservation, request] = await Promise.all([
      this.runs.store.db.usageReservation.findFirst({
        where: {
          workspaceId: context.workspaceId,
          idempotencyKey: `m08:${step.idempotencyKey}`,
        },
        select: { id: true },
      }),
      this.runs.store.db.providerRequest.findFirst({
        where: {
          workspaceId: context.workspaceId,
          correlationId: step.id,
        },
        select: { id: true },
      }),
    ]);
    return reservation !== null || request !== null;
  }
  private async releaseClaim(
    context: Context,
    run: Run,
    step: Step,
    amount: number,
  ): Promise<void> {
    const released = await this.runs.store.mutate(
      context,
      run.id,
      "dispatch_released",
      async (db) => {
        const reset = await db.videoRunStep.updateMany({
          where: {
            id: step.id,
            runId: run.id,
            state: "RUNNING",
            providerJobId: null,
            costMinor: amount,
          },
          data: { state: "PENDING", costMinor: null, providerId: null, startedAt: null },
        });
        if (reset.count !== 1) throw new ConflictException("Dispatch claim changed");
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
        await db.budgetEnvelope.updateMany({
          where: { id: budget.id, revision: budget.revision },
          data: { reservedMinor: budget.reservedMinor - amount, revision: budget.revision + 1 },
        });
        return {
          value: null,
          payload: { amountMinor: amount, reason: "NOT_DISPATCHED" },
          stepId: step.id,
        };
      },
    );
    await this.runs.events?.publish(released.event);
  }
  private async saveJob(
    context: Context,
    run: Run,
    step: Step,
    providerJobId: string,
  ): Promise<Step> {
    const saved = await this.runs.store.mutate(
      context,
      run.id,
      "provider_submitted",
      async (db) => {
        const changed = await db.videoRunStep.updateMany({
          where: { id: step.id, runId: run.id, state: "RUNNING", providerJobId: null },
          data: { providerJobId, state: "WAITING_EXTERNAL" },
        });
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (!changed.count && current.providerJobId !== providerJobId)
          throw new ConflictException("Provider job claim changed");
        return {
          value: current,
          payload: { providerJobId },
          stepId: step.id,
        };
      },
    );
    await this.runs.events?.publish(saved.event);
    return saved.value;
  }
  private port(step: Step, ports: { primary: VideoGenPort; fallback: VideoGenPort }): VideoGenPort {
    const registry = new Map(
      [ports.primary, ports.fallback].map((port) => [port.providerId, port]),
    );
    const port = step.providerId ? registry.get(step.providerId) : undefined;
    if (!port) throw new ConflictException("RECONCILE_REQUIRED: stored provider is unavailable");
    return port;
  }
  private completionOutput(
    step: Step,
    artifact: import("../runs/runs.types.js").Artifact,
    meta: ReturnType<NonNullable<VideoGenPort["metadata"]>> | undefined,
  ): ReturnType<typeof json> {
    return json({
      storageArtifacts: [artifact],
      ...(meta
        ? {
            receipt: {
              key: step.key,
              providerId: step.providerId,
              providerJobId: step.providerJobId,
              ...meta,
              objectKey: artifact.objectKey,
              checksumSha256: artifact.checksumSha256,
              mimeType: "video/mp4",
            },
          }
        : {}),
    });
  }
  private recordSuccess(step: Step, started: number): void {
    metrics
      .counter("run_provider_results", "Provider outcomes")
      .inc({ provider: step.providerId ?? "unconfigured", status: "succeeded" });
    metrics
      .counter("run_provider_cost_minor", "Provider cost in cents")
      .inc({ provider: step.providerId ?? "unconfigured" }, step.costMinor ?? 0);
    metrics
      .histogram("run_provider_latency_ms", "Provider latency")
      .observe({ provider: step.providerId ?? "unconfigured" }, Date.now() - started);
  }
  private async complete(
    context: Context,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<void> {
    const started = step.startedAt?.getTime() ?? Date.now();
    const body = await withSpan(
      "run.provider.fetch",
      () => this.port(step, ports).fetch(step.providerJobId!),
      "CLIENT",
    );
    const artifact = await this.artifacts.put(context, "clips", body, "video/mp4");
    const meta = this.port(step, ports).metadata?.(
      step.providerJobId!,
      ShotSpecSchema.parse(step.input),
    );
    if (meta && meta.costMinor > (step.costMinor ?? 0))
      throw new ConflictException("RECONCILE_REQUIRED: provider billing exceeded reservation");
    const result = await this.runs.store.mutate(
      context,
      step.runId,
      "step_completed",
      async (db, run, tx) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (SETTLED_SHOTS.some((state) => state === current.state))
          return { value: false, payload: { replay: true } };
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: step.runId } });
        const reserved = step.costMinor ?? 0;
        const cost = meta?.costMinor ?? reserved;
        await this.paid.commitJob(tx, context, current, cost);
        await db.videoRunStep.updateMany({
          where: { id: step.id },
          data: {
            state: "SUCCEEDED",
            costMinor: cost,
            finishedAt: new Date(),
            output: this.completionOutput(step, artifact, meta),
          },
        });
        await db.budgetEnvelope.updateMany({
          where: { id: budget.id },
          data: {
            reservedMinor: budget.reservedMinor - reserved,
            spentMinor: budget.spentMinor + cost,
            revision: budget.revision + 1,
          },
        });
        await failSettledGeneration(db, run);
        return {
          value: true,
          payload: { costMinor: cost, warn: budget.spentMinor + cost > 600 },
          stepId: step.id,
        };
      },
    );
    if (result.value) {
      this.recordSuccess(step, started);
    }
    await this.runs.events?.publish(result.event);
  }
}
