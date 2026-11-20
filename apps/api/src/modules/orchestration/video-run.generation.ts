import { z } from "zod";
import { ProviderFailure } from "@reelforge/ai-providers";
import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { withSpan, metrics } from "@reelforge/observability";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import { DispatchAdmissionError, RunPaidCalls } from "../usage-budget/run-paid.js";
import {
  DISPATCHING,
  clearResolvedSubmissionHold,
  SETTLED_SHOTS,
  failSettledGeneration,
} from "../runs/run-outcomes.js";
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
    if (!step.providerJobId && step.state !== "RUNNING") {
      if (
        run.state === "CANCELED" ||
        run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
        run.pauseReason === "OPERATOR_ABANDONED"
      )
        return null;
      if (run.state !== "GENERATING") return 12000;
    }
    if (!step.providerJobId && step.state !== "RUNNING") await this.boundary.check(context, run);
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
    return this.saveJob(context, run, claimed, result.providerJobId);
  }
  private async recoverJob(
    context: Context,
    run: Run,
    step: Step,
    ports: { primary: VideoGenPort; fallback: VideoGenPort },
  ): Promise<Step> {
    const request = await this.runs.store.db.providerRequest.findUnique({
      where: {
        workspaceId_correlationId: { workspaceId: context.workspaceId, correlationId: step.id },
      },
    });
    if (!request || ["PENDING", "ADMISSION_ROLLED_BACK"].includes(request.errorCode ?? "")) {
      await this.paid.rollbackAdmission(context, step);
      return this.runs.store
        .scoped(context)
        .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    }
    const receipt = z
      .object({ providerJobId: z.string().min(1) })
      .safeParse(request.responseMetadata);
    if (receipt.success) return this.saveJob(context, run, step, receipt.data.providerJobId);
    if (request.errorCode === DISPATCHING && Date.now() - request.createdAt.getTime() < 120_000)
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
    return this.saveJob(context, run, step, recovered.providerJobId);
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
          current.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
          current.pauseReason === "OPERATOR_ABANDONED"
        )
          throw new ConflictException("Run is not generating");
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
        const provider = budget.route === "FALLBACK" ? ports.fallback : ports.primary;
        provider.assertKey?.();
        const amount = provider.estimate(shot, budget.route === "FALLBACK");
        if (!envelopeRoom(budget, amount))
          throw new ConflictException({ code: "BUDGET_CAP", message: "Envelope exhausted" });
        const claimed = await db.videoRunStep.updateMany({
          where: { id: step.id, state: "PENDING", idempotencyKey: step.idempotencyKey },
          data: {
            state: "RUNNING",
            startedAt: new Date(),
            costMinor: amount,
            providerId: provider.providerId,
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
      async (db, currentRun, tx) => {
        const changed = await db.videoRunStep.updateMany({
          where: { id: step.id, runId: run.id, state: "RUNNING", providerJobId: null },
          data: { providerJobId, state: "WAITING_EXTERNAL" },
        });
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (!changed.count && current.providerJobId !== providerJobId)
          throw new ConflictException("Provider job claim changed");
        await clearResolvedSubmissionHold(db, tx, currentRun, step.id);
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
