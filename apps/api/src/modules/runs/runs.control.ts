import { SAVED_CAPTION_PLAN_UNUSABLE } from "../usage-budget/run-caption-admission.js";
import { closeSteps, releaseSteps } from "./run-close-steps.js";
import { refusalRewrite } from "../orchestration/video-run.refusal.js";
import { writeDecisionLocked } from "../autonomy/run-decision.js";
import { ConflictException, Injectable } from "@nestjs/common";
import { createReshoot, replayedReshoot } from "./run-reshoot.js";
import { RunsService } from "./runs.service.js";
import { RunsBoundary } from "./runs.boundary.js";
import { json, type Context, type Run, type Scoped, type Transaction } from "./runs.types.js";
import {
  activeSubmissionHold,
  generationFailure,
  remainingSubmissionHold,
  SETTLED_SHOTS,
  submissionHold,
  storedSubmissionHold,
} from "./run-outcomes.js";
import {
  canRollback,
  hasSettledCharge,
  readAdmission,
} from "../usage-budget/run-admission-state.js";
import { closeReleasedMedia } from "../usage-budget/run-paid-admission.js";
import { openCritics } from "../usage-budget/critic-admission.js";

@Injectable()
export class RunsControl {
  public constructor(
    private readonly runs: RunsService,
    private readonly boundary: RunsBoundary,
  ) {}
  public async approve(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state === "AWAITING_APPROVAL") {
      const result = await this.runs.store.mutate(context, id, "approved", (db, current, tx) =>
        writeDecisionLocked(db, tx, current, context, "APPROVE", false),
      );
      await this.runs.events?.publish(result.event);
    } else {
      if (run.effectiveAutonomy !== "L1") throw new ConflictException("No stage approval required");
      const result = await this.runs.store.mutate(
        context,
        id,
        "stage_approved",
        async (db, current, tx) => {
          const hold = await activeSubmissionHold(db, tx, current);
          if (hold) throw new ConflictException("Stage approval is blocked during reconciliation");
          const changed = await db.videoRunStep.updateMany({
            where: { runId: id, key: run.state, state: "WAITING_APPROVAL" },
            data: { state: "SUCCEEDED" },
          });
          if (!changed.count) throw new ConflictException("No stage awaiting approval");
          return { value: null, payload: { stage: run.state } };
        },
      );
      await this.runs.events?.publish(result.event);
      await this.runs.enqueue(context, await this.runs.store.get(context, id));
    }
  }
  public async reedit(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    if (run.state !== "CRITIC") throw new ConflictException("Re-edit requires critic boundary");
    const result = await this.runs.store.mutate(
      context,
      id,
      "reedit_requested",
      async (db, current, tx) => {
        if (current.state !== "CRITIC") throw new ConflictException("Critic stage changed");
        await this.fenceCritics(context, db, tx, current);
        const key = `${id}:REEDIT:1`;
        if (await db.videoRunStep.findFirst({ where: { runId: id, key: "REEDIT" } }))
          throw new ConflictException("Only one full re-edit per run");
        await db.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: id,
            key: "REEDIT",
            idempotencyKey: key,
            input: {},
          },
        });
        return { value: null, payload: { fullReedits: 1 } };
      },
    );
    await this.runs.events?.publish(result.event);
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
  private async fenceCritics(
    context: Context,
    db: Scoped,
    tx: Transaction,
    run: Run,
  ): Promise<void> {
    if (run.pauseReason === "EMERGENCY_STOP")
      throw new ConflictException("Resume the stopped run before editing");
    if (await activeSubmissionHold(db, tx, run))
      throw new ConflictException("Reconcile the unknown attempt before editing");
    const critics = await openCritics(db, tx, run);
    if (critics.some((critic) => !canRollback(critic)))
      throw new ConflictException("Settle the prior critic before editing");
    if (critics.length)
      await releaseSteps(
        context.workspaceId,
        db,
        tx,
        run.id,
        critics.map(({ step }) => step),
        "CRITIC_SUPERSEDED",
      );
  }
  public async cancel(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const result = await this.runs.store.mutate(context, id, "transition", async (db, run, tx) => {
      if (["PUBLISHED", "LEARNING", "FAILED", "CANCELED"].includes(run.state))
        throw new ConflictException("Run is terminal");
      const steps = await db.videoRunStep.findMany({
        where: {
          runId: id,
          state: { notIn: [...SETTLED_SHOTS] },
          providerJobId: null,
        },
      });
      const hold = await closeSteps(context, db, tx, run, steps, "RUN_CANCELED");
      await db.videoRun.updateMany({
        where: { id },
        data: {
          state: "CANCELED",
          pauseReason: hold ?? (await storedSubmissionHold(db, id, run.pauseReason)),
        },
      });
      return { value: null, payload: { from: run.state, to: "CANCELED" } };
    });
    await this.runs.events?.publish(result.event);
  }
  public async abandon(context: Context, id: string, stepId: string): Promise<void> {
    this.runs.editor(context);
    const result = await this.runs.store.mutate(
      context,
      id,
      "step_abandoned",
      async (db, run, tx) => {
        const step = await db.videoRunStep.findFirst({
          where: {
            id: stepId,
            runId: id,
            state: "RUNNING",
            providerJobId: null,
            OR: [{ key: { startsWith: "media:" } }, { key: { startsWith: "shot-" } }],
          },
        });
        if (!step) throw new ConflictException("Step has no unknown submission to abandon");
        const admission = await readAdmission(tx, context, step);
        if (admission.evidence === "released-nondispatch") {
          await closeReleasedMedia(db, run, step);
          await this.updateAbandonHold(db, tx, run);
          return { value: null, payload: { reason: "PROVIDER_NOT_DISPATCHED" }, stepId };
        }
        if (!canRollback(admission)) {
          const reason = (await remainingSubmissionHold(db, tx, run)) ?? submissionHold(step.id);
          if (
            run.pauseReason !== "EMERGENCY_STOP" &&
            !run.pauseReason?.startsWith("RECONCILE_REQUIRED")
          )
            await db.videoRun.updateMany({ where: { id }, data: { pauseReason: reason } });
          return { value: reason, payload: { reason }, stepId, eventType: "reconcile_required" };
        }
        if (
          !run.pauseReason?.startsWith("RECONCILE_REQUIRED") &&
          run.pauseReason !== "OPERATOR_ABANDONED"
        )
          throw new ConflictException("Run is not awaiting reconciliation");
        await releaseSteps(context.workspaceId, db, tx, id, [step], "OPERATOR_ABANDONED");
        if (run.state !== "CANCELED" && step.key.startsWith("shot-")) {
          const rewrite = refusalRewrite(step);
          await db.videoRunStep.create({
            data: {
              workspaceId: context.workspaceId,
              runId: id,
              key: step.key,
              attempt: step.attempt + 1,
              idempotencyKey: `${step.idempotencyKey}:retry:${step.attempt + 1}`,
              input: json(step.input),
              ...(rewrite && { output: { refusalRewrite: rewrite } }),
            },
          });
        }
        await this.updateAbandonHold(db, tx, run);
        return { value: null, payload: { key: step.key }, stepId };
      },
    );
    await this.runs.events?.publish(result.event);
    if (result.value)
      throw new ConflictException("Reconcile the provider submission before abandoning");
  }
  private async updateAbandonHold(db: Scoped, tx: Transaction, run: Run): Promise<void> {
    if (run.pauseReason === "EMERGENCY_STOP") return;
    const hold = await remainingSubmissionHold(db, tx, run);
    await db.videoRun.updateMany({
      where: { id: run.id },
      data: { pauseReason: hold ?? (run.state === "CANCELED" ? null : "OPERATOR_ABANDONED") },
    });
  }

  public async resume(context: Context, id: string): Promise<void> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    const result = await this.runs.store.mutate(context, id, "resumed", async (db, current, tx) => {
      if (current.revision !== run.revision) throw new ConflictException("Run changed");
      const hold = await activeSubmissionHold(db, tx, current);
      if (hold) {
        if (hold !== current.pauseReason && current.pauseReason !== "EMERGENCY_STOP")
          await db.videoRun.updateMany({ where: { id }, data: { pauseReason: hold } });
        return {
          value: false,
          payload: { reason: hold },
          eventType: "reconcile_required",
        };
      }
      await this.assertGenerationResumable(db, current);
      const clearedStop =
        current.pauseReason === "EMERGENCY_STOP" &&
        [
          "PLANNING",
          "SCRIPTING",
          "SHOT_PLANNING",
          "GENERATING",
          "ASSEMBLING",
          "CRITIC",
          "AWAITING_APPROVAL",
        ].includes(current.state);
      const abandoned = current.pauseReason === "OPERATOR_ABANDONED";
      const resolved =
        current.pauseReason?.startsWith("RECONCILE_REQUIRED") &&
        ["SCRIPTING", "SHOT_PLANNING", "GENERATING", "ASSEMBLING", "CRITIC"].includes(
          current.state,
        );
      if (
        !clearedStop &&
        !resolved &&
        !abandoned &&
        !["PAUSED_BUDGET", "NEEDS_HUMAN"].includes(current.state)
      )
        throw new ConflictException("Run cannot resume");
      const state =
        (clearedStop || resolved || abandoned) && current.state !== "PAUSED_BUDGET"
          ? current.state
          : "GENERATING";
      if (current.state === "PAUSED_BUDGET") await rearmDeniedKeyframes(db, current);
      await db.videoRun.updateMany({ where: { id }, data: { state, pauseReason: null } });
      return {
        value: true,
        payload: { from: current.state, to: state, reason: null },
        eventType: abandoned ? "resumed" : "transition",
      };
    });
    await this.runs.events?.publish(result.event);
    if (!result.value) throw new ConflictException("Reconcile the unknown attempt before resuming");
    await this.runs.enqueue(context, await this.runs.store.get(context, id));
  }
  public async reshoot(
    context: Context,
    id: string,
    ordinal: number,
    sourceStepId: string,
  ): Promise<string | null> {
    this.runs.editor(context);
    const run = await this.runs.store.get(context, id);
    await this.boundary.check(context, run);
    const result = await this.runs.store.mutate(
      context,
      id,
      "reshoot_requested",
      async (db, current, tx) => {
        const shots = await db.videoRunStep.findMany({
          where: { runId: id, key: `shot-${ordinal}` },
          orderBy: { attempt: "desc" },
        });
        const latest = shots[0];
        if (!latest) throw new ConflictException("Reshoot source unavailable");
        const source = shots.find((step) => step.id === sourceStepId);
        if (!source) throw new ConflictException("Reshoot source changed");
        const replacement = await replayedReshoot(db, current, ordinal, source, shots);
        if (replacement) {
          if (current.state === "CRITIC" && replacement.state === "PENDING") {
            await this.fenceCritics(context, db, tx, current);
            await db.videoRun.updateMany({ where: { id }, data: { state: "GENERATING" } });
          }
          return {
            value: replacement.id,
            eventType: "reshoot_replayed",
            payload: { ordinal, attempt: replacement.attempt },
          };
        }
        if (current.state !== "CRITIC" || source.id !== latest.id || source.state !== "SUCCEEDED")
          throw new ConflictException("Reshoots require a settled shot at the critic boundary");
        await this.fenceCritics(context, db, tx, current);
        if (!hasSettledCharge(await readAdmission(tx, context, source)))
          throw new ConflictException("Reconcile the reshoot source before editing");
        return createReshoot(db, current, ordinal, source);
      },
    );
    await this.runs.events?.publish(result.event);
    if (result.value) {
      const current = await this.runs.store.get(context, id);
      if (current.state === "GENERATING") await this.runs.enqueue(context, current);
    }
    return result.value;
  }
  private async assertGenerationResumable(db: Scoped, current: Run): Promise<void> {
    if (
      current.state === "ASSEMBLING" &&
      (await db.videoRunStep.findFirst({
        where: {
          runId: current.id,
          key: "ASSEMBLING",
          state: "FAILED",
          OR: [
            { error: { path: ["code"], equals: SAVED_CAPTION_PLAN_UNUSABLE } },
            { error: { path: ["localRenderFailures"], gt: 0 } },
          ],
        },
      }))
    )
      throw new ConflictException(
        "Saved captions cannot fit. Start a new Short with shorter narration.",
      );
    if (
      current.state === "NEEDS_HUMAN" &&
      (await db.videoRunStep.findFirst({
        where: {
          runId: current.id,
          key: { startsWith: "shot-" },
          state: "FAILED",
          error: { path: ["code"], equals: "PROVIDER_REFUSED" },
        },
      }))
    )
      throw new ConflictException("Refused shot requires human resolution");
    if (current.state === "NEEDS_HUMAN" && (await generationFailure(db, current.id)))
      throw new ConflictException("Required generation input failed");
  }
}

async function rearmDeniedKeyframes(db: Scoped, run: Run): Promise<void> {
  await db.videoRunStep.updateMany({
    where: {
      runId: run.id,
      state: "CANCELLED",
      providerJobId: null,
      key: { startsWith: "media:keyframe:" },
      output: { path: ["closedBy"], equals: "BUDGET_DENIED_NOT_DISPATCHED" },
    },
    data: { output: { closedBy: "NOT_DISPATCHED" } },
  });
}
