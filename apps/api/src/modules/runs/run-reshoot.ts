import { MAX_SHOT_RESHOOTS, shotReshoots } from "./shot-reshoots.js";
import { ShotSpecSchema } from "@reelforge/contracts";
import { envelopeRoom, pinnedBudget } from "../usage-budget/run-envelope.js";
import type { Json, Run, Scoped, Step } from "./runs.types.js";

export async function replayedReshoot(
  db: Scoped,
  current: Run,
  ordinal: number,
  source: Step,
  shots: Step[],
): Promise<Step | undefined> {
  const replacement = shots.find((step) => step.attempt === source.attempt + 1);
  if (!replacement) return undefined;
  // Older reshoot events identify the source by its unique run, ordinal and attempt.
  const command = await db.runEvent.findFirst({
    where: {
      runId: current.id,
      type: "reshoot_requested",
      AND: [
        { payload: { path: ["ordinal"], equals: ordinal } },
        { payload: { path: ["attempt"], equals: replacement.attempt } },
      ],
    },
  });
  return command ? replacement : undefined;
}

export async function createReshoot(
  db: Scoped,
  current: Run,
  ordinal: number,
  source: Step,
): Promise<{ value: string | null; payload: Json; stepId?: string; eventType?: string }> {
  const id = current.id;
  const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: id } });
  if (
    (await shotReshoots(db, id)).filter((request) => request.key === source.key).length >=
      MAX_SHOT_RESHOOTS ||
    !envelopeRoom(
      {
        ...budget,
        hardCapMinor: Math.min(pinnedBudget(current).hardCapMinor, budget.hardCapMinor),
      },
      source.costMinor ?? 0,
    )
  ) {
    await db.videoRun.updateMany({
      where: { id },
      data: {
        state: "NEEDS_HUMAN",
        pauseReason: "Reshoot cap or envelope exhausted",
        ...(current.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
      },
    });
    return {
      value: null,
      eventType: "transition",
      payload: { from: "CRITIC", to: "NEEDS_HUMAN" },
    };
  }
  const attempt = source.attempt + 1;
  const step = await db.videoRunStep.create({
    data: {
      workspaceId: current.workspaceId,
      runId: id,
      key: source.key,
      attempt,
      input: ShotSpecSchema.parse(source.input),
      idempotencyKey: `${id}:${ordinal}:${attempt}`,
    },
  });
  await db.videoRun.updateMany({
    where: { id },
    data: { state: "GENERATING", pauseReason: null },
  });
  return {
    value: step.id,
    stepId: step.id,
    payload: { ordinal, attempt, sourceStepId: source.id, from: "CRITIC", to: "GENERATING" },
  };
}
