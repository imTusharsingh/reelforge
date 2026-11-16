import { ConflictException, Injectable } from "@nestjs/common";
import { ShotSpecSchema } from "@reelforge/contracts";
import { withSpan, metrics } from "@reelforge/observability";
import { RunsService } from "../runs/runs.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { RunsArtifacts } from "../runs/runs.artifacts.js";
import { json, type Context, type Run, type Step } from "../runs/runs.types.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { envelopeRoom } from "../usage-budget/run-envelope.js";
import { RunFallback } from "./video-run.fallback.js";
import { StubVideoGenPort, type VideoGenPort } from "./video-run.handlers.js";

export class ProviderOutage extends Error {
  public constructor(public readonly notDispatched: boolean) {
    super("Provider outage");
  }
}
@Injectable()
export class RunGeneration {
  public provider: VideoGenPort = new StubVideoGenPort();
  public fallbackProvider: VideoGenPort = new StubVideoGenPort();
  public constructor(
    private readonly runs: RunsService,
    private readonly boundary: RunsBoundary,
    private readonly paid: RunPaidCalls,
    private readonly artifacts: RunsArtifacts,
    private readonly fallback: RunFallback,
  ) {}
  public async process(context: Context, run: Run, stepId: string): Promise<number | null> {
    const db = this.runs.store.scoped(context);
    let step = await db.videoRunStep.findFirst({ where: { id: stepId, runId: run.id } });
    if (!step) throw new ConflictException("Step not found in run");
    if (["SUCCEEDED", "SKIPPED", "CANCELLED"].includes(step.state)) return null;
    if (run.state !== "GENERATING") return 12000;
    await this.boundary.check(context, run);
    if (!step.providerJobId) {
      try {
        step = await this.submit(context, run, step);
      } catch (error) {
        if (!(error instanceof ProviderOutage) || !error.notDispatched) throw error;
        const failed = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        await this.fallback.apply(context, run, failed);
        await this.runs.enqueue(context, await this.runs.store.get(context, run.id));
        return null;
      }
      if (!step.providerJobId) return 12000;
    }
    const status = await withSpan(
      "run.provider.poll",
      () => this.port(step).poll(step.providerJobId!),
      "CLIENT",
    );
    if (status === "queued" || status === "running") return 12000;
    if (status !== "succeeded") {
      metrics
        .counter("run_provider_results", "Provider outcomes")
        .inc({ provider: step.providerId ?? "stub", status });
      throw new ConflictException("Provider result requires human reconciliation");
    }
    await this.complete(context, step);
    return null;
  }
  private async submit(context: Context, run: Run, step: Step): Promise<Step> {
    if (step.state === "RUNNING" || step.state === "WAITING_EXTERNAL") {
      const recovered = await withSpan(
        "run.provider.reconcile",
        () => this.port(step).reconcile(step.idempotencyKey),
        "CLIENT",
      );
      if (!recovered)
        throw new ConflictException("Submission outcome unknown; no paid resubmission");
      return this.saveJob(context, run, step, recovered.providerJobId);
    }
    const shot = ShotSpecSchema.parse(step.input);
    const envelope = await this.runs.store
      .scoped(context)
      .budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    const amount = (envelope.route === "FALLBACK" ? this.fallbackProvider : this.provider).estimate(
      shot,
      envelope.route === "FALLBACK",
    );
    const claim = await this.runs.store.mutate(
      context,
      run.id,
      "dispatch_reserved",
      async (db, current) => {
        if (current.state !== "GENERATING") throw new ConflictException("Run is not generating");
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
        if (!envelopeRoom(budget, amount)) throw new ConflictException("Envelope exhausted");
        const claimed = await db.videoRunStep.updateMany({
          where: { id: step.id, state: "PENDING" },
          data: {
            state: "RUNNING",
            startedAt: new Date(),
            costMinor: amount,
            providerId: envelope.route === "FALLBACK" ? "v3-stub-xai" : "v3-stub-gemini",
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
    await this.paid.reserve(context, run, step, amount);
    await this.boundary.check(context, await this.runs.store.get(context, run.id));
    const result = await withSpan(
      "run.provider.submit",
      () =>
        (envelope.route === "FALLBACK" ? this.fallbackProvider : this.provider).submit(
          shot,
          step.idempotencyKey,
        ),
      "CLIENT",
    );
    return this.saveJob(context, run, step, result.providerJobId);
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
        await db.videoRunStep.updateMany({
          where: { id: step.id, runId: run.id },
          data: { providerJobId, state: "WAITING_EXTERNAL" },
        });
        return {
          value: await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } }),
          payload: { providerJobId },
          stepId: step.id,
        };
      },
    );
    await this.runs.events?.publish(saved.event);
    return saved.value;
  }
  private port(step: Step): VideoGenPort {
    return step.providerId === "v3-stub-xai" ? this.fallbackProvider : this.provider;
  }
  private async complete(context: Context, step: Step): Promise<void> {
    const started = step.startedAt?.getTime() ?? Date.now();
    const body = await withSpan(
      "run.provider.fetch",
      () => this.port(step).fetch(step.providerJobId!),
      "CLIENT",
    );
    const artifact = await this.artifacts.put(context, "clips", body, "application/json");
    await this.paid.finish(context, step, true, step.costMinor ?? 0);
    const result = await this.runs.store.mutate(
      context,
      step.runId,
      "step_completed",
      async (db) => {
        const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
        if (current.state === "SUCCEEDED") return { value: false, payload: { replay: true } };
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: step.runId } });
        const cost = step.costMinor ?? 0;
        await db.videoRunStep.updateMany({
          where: { id: step.id },
          data: {
            state: "SUCCEEDED",
            finishedAt: new Date(),
            output: json({ stub: true, storageArtifacts: [artifact] }),
          },
        });
        await db.budgetEnvelope.updateMany({
          where: { id: budget.id },
          data: {
            reservedMinor: budget.reservedMinor - cost,
            spentMinor: budget.spentMinor + cost,
            revision: budget.revision + 1,
          },
        });
        return {
          value: true,
          payload: { costMinor: cost, warn: budget.spentMinor + cost > 600 },
          stepId: step.id,
        };
      },
    );
    if (result.value) {
      metrics
        .counter("run_provider_results", "Provider outcomes")
        .inc({ provider: step.providerId ?? "stub", status: "succeeded" });
      metrics
        .counter("run_provider_cost_minor", "Provider cost in cents")
        .inc({ provider: step.providerId ?? "stub" }, step.costMinor ?? 0);
      metrics
        .histogram("run_provider_latency_ms", "Provider latency")
        .observe({ provider: step.providerId ?? "stub" }, Date.now() - started);
    }
    await this.runs.events?.publish(result.event);
  }
}
