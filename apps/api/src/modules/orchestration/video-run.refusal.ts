import { lockVideoJob } from "../usage-budget/video-job-evidence.js";
import { hasVideoDelivery, terminalVideo } from "../usage-budget/run-video-terminal.js";
import { carryRefusalBill } from "../usage-budget/run-pending-receipt.js";
import { readReceiptBudget } from "../usage-budget/run-shot-receipt.js";
import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { ShotSpecSchema } from "@reelforge/contracts";
import {
  clearResolvedSubmissionHold,
  failSettledGeneration,
  generationFailure,
  SETTLED_SHOTS,
} from "../runs/run-outcomes.js";
import type { RunsService } from "../runs/runs.service.js";
import type { Context, Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import type { RunPaidCalls } from "../usage-budget/run-paid.js";

const rewriteSchema = z.object({ sourceStepId: z.uuid(), providerId: z.string().min(1) });
export function refusalRewrite(step: Step): z.infer<typeof rewriteSchema> | undefined {
  const output = step.output;
  if (!output || typeof output !== "object" || !("refusalRewrite" in output)) return undefined;
  return rewriteSchema.parse(output.refusalRewrite);
}

export async function settleVideoRefusal(
  runs: RunsService,
  paid: RunPaidCalls,
  context: Context,
  step: Step,
  submissionJobId?: string | null,
): Promise<void> {
  const result = await runs.store.mutate(
    context,
    step.runId,
    "shot_refused",
    async (db, run, tx) => {
      const current = await lockVideoJob(tx, db, run, step.id);
      if (SETTLED_SHOTS.some((state) => state === current.state) || hasVideoDelivery(current))
        return { value: null, payload: { replay: true } };
      if (
        !current.providerId ||
        current.state !== (submissionJobId === undefined ? "WAITING_EXTERNAL" : "RUNNING") ||
        current.providerJobId !== step.providerJobId ||
        current.idempotencyKey !== step.idempotencyKey
      )
        throw new ConflictException("Refused job claim changed");
      const rewritten = !!refusalRewrite(current);
      const active = await acceptsRewrite(db, run);
      const retry = active && !rewritten;
      const recorded = terminalVideo(current);
      if (recorded && recorded.status !== "refused")
        return { value: null, payload: { replay: true } };
      const evidence = {
        providerJobId: recorded?.providerJobId ?? submissionJobId ?? current.providerJobId,
        retry,
      };
      await recordRefusal(db, tx, paid, context, current, evidence);
      const pauseReason = await clearResolvedSubmissionHold(db, tx, run, current.id);
      if (retry) {
        const replacement = await createRewrite(db, run, current);
        return {
          value: replacement.id,
          payload: { rewriteStepId: replacement.id },
          stepId: current.id,
        };
      }
      await closeRefusedRun(db, { ...run, pauseReason }, active);
      return {
        value: null,
        payload: { reason: "PROVIDER_REFUSED", rewriteCount: Number(rewritten) },
        stepId: current.id,
      };
    },
  );
  await runs.events?.publish(result.event);
  if (result.value)
    await runs.queue?.enqueue(runs.job(context, step.runId, result.value), result.event.sequence);
}

async function closeRefusedRun(db: Scoped, run: Run, active: boolean): Promise<void> {
  if (!active) await failSettledGeneration(db, run);
  else
    await db.videoRun.updateMany({
      where: { id: run.id },
      data: {
        state: "NEEDS_HUMAN",
        pauseReason: run.pauseReason?.startsWith("RECONCILE_REQUIRED")
          ? run.pauseReason
          : "PROVIDER_REFUSED",
        ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
      },
    });
}

async function acceptsRewrite(db: Scoped, run: Run): Promise<boolean> {
  if (run.state === "NEEDS_HUMAN") return !(await generationFailure(db, run.id));
  return run.state === "GENERATING" || run.state === "PAUSED_BUDGET";
}

async function recordRefusal(
  db: Scoped,
  tx: Transaction,
  paid: RunPaidCalls,
  context: Context,
  current: Step,
  { providerJobId, retry }: { providerJobId: string | null; retry: boolean },
): Promise<void> {
  const amount = current.costMinor ?? 0;
  const cost = await paid.settleFailedRequest(
    tx,
    context,
    current,
    "Video provider refused the shot",
    true,
    readReceiptBudget(current.output)?.estimateMinor ?? amount,
    providerJobId,
  );
  const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: current.runId } });
  await db.budgetEnvelope.updateMany({
    where: { id: budget.id },
    data: {
      reservedMinor: budget.reservedMinor - amount,
      spentMinor: budget.spentMinor + cost,
      overageMinor: Math.max(
        budget.overageMinor,
        budget.spentMinor + cost + budget.reservedMinor - amount - budget.hardCapMinor,
      ),
      revision: budget.revision + 1,
    },
  });
  await db.videoRunStep.updateMany({
    where: { id: current.id },
    data: {
      ...carryRefusalBill(current),
      state: retry ? "SKIPPED" : "FAILED",
      costMinor: cost,
      providerJobId,
      finishedAt: new Date(),
      error: { code: "PROVIDER_REFUSED", rewriteCount: Number(!!refusalRewrite(current)) },
    },
  });
}

async function createRewrite(db: Scoped, run: Run, current: Step): Promise<Step> {
  if (!current.providerId) throw new ConflictException("Refused job has no provider");
  const shot = ShotSpecSchema.parse(current.input);
  return db.videoRunStep.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      key: current.key,
      attempt: current.attempt + 1,
      idempotencyKey: `${current.id}:rewrite`,
      input: {
        ...shot,
        keyframePrompt: `Illustrate the following narration using simple abstract shapes: ${shot.voLine}`,
        motionPrompt: `Use gentle motion in an abstract illustration of the narration: ${shot.voLine}`,
        negativePrompt: [shot.negativePrompt, "No people, logos, or text."]
          .filter(Boolean)
          .join(" "),
      },
      output: {
        refusalRewrite: { sourceStepId: current.id, providerId: current.providerId },
      },
    },
  });
}
