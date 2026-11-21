import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { ShotSpecSchema } from "@reelforge/contracts";
import { clearResolvedSubmissionHold, SETTLED_SHOTS } from "../runs/run-outcomes.js";
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
  dispatched: boolean,
): Promise<void> {
  const result = await runs.store.mutate(
    context,
    step.runId,
    "shot_refused",
    async (db, run, tx) => {
      const current = await db.videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      if (SETTLED_SHOTS.some((state) => state === current.state))
        return { value: null, payload: { replay: true } };
      if (
        !current.providerId ||
        current.state !== (dispatched ? "WAITING_EXTERNAL" : "RUNNING") ||
        current.providerJobId !== step.providerJobId ||
        current.idempotencyKey !== step.idempotencyKey
      )
        throw new ConflictException("Refused job claim changed");
      const rewritten = !!refusalRewrite(current);
      const active = ["GENERATING", "PAUSED_BUDGET", "NEEDS_HUMAN"].includes(run.state);
      const retry = active && !rewritten;
      await recordRefusal(db, tx, paid, context, current, dispatched, retry);
      const pauseReason = await clearResolvedSubmissionHold(db, tx, run, current.id);
      if (retry) {
        const replacement = await createRewrite(db, run, current);
        return {
          value: replacement.id,
          payload: { rewriteStepId: replacement.id },
          stepId: current.id,
        };
      }
      if (active)
        await db.videoRun.updateMany({
          where: { id: run.id },
          data: {
            state: "NEEDS_HUMAN",
            pauseReason: pauseReason?.startsWith("RECONCILE_REQUIRED")
              ? pauseReason
              : "PROVIDER_REFUSED",
            ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
          },
        });
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

async function recordRefusal(
  db: Scoped,
  tx: Transaction,
  paid: RunPaidCalls,
  context: Context,
  current: Step,
  dispatched: boolean,
  retry: boolean,
): Promise<void> {
  const amount = current.costMinor ?? 0;
  await paid.settleFailedRequest(
    tx,
    context,
    current,
    "Video provider refused the shot",
    dispatched,
  );
  await db.budgetEnvelope.updateMany({
    where: { runId: current.runId },
    data: {
      reservedMinor: { decrement: amount },
      spentMinor: { increment: dispatched ? amount : 0 },
      revision: { increment: 1 },
    },
  });
  await db.videoRunStep.updateMany({
    where: { id: current.id },
    data: {
      state: retry ? "SKIPPED" : "FAILED",
      costMinor: dispatched ? amount : 0,
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
