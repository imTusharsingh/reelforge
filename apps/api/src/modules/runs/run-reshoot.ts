import { ShotSpecSchema } from "@reelforge/contracts";
import { envelopeRoom, pinnedBudget } from "../usage-budget/run-envelope.js";
import type { Json, Run, Scoped, Step } from "./runs.types.js";

export async function replayedReshoot(
  db: Scoped,
  current: Run,
  ordinal: number,
  source: Step,
  latest: Step,
  shots: Step[],
  boundSource: boolean,
): Promise<Step | undefined> {
  const id = current.id;
  const previousCommand = await db.runEvent.findFirst({
    where: {
      runId: id,
      type: "reshoot_requested",
      AND: [
        { payload: { path: ["ordinal"], equals: ordinal } },
        ...(boundSource ? [{ payload: { path: ["attempt"], equals: source.attempt + 1 } }] : []),
      ],
    },
    orderBy: { sequence: "desc" },
  });
  const command = previousCommand?.payload;
  const replacement =
    command && typeof command === "object" && "attempt" in command
      ? shots.find((step) => step.attempt === command.attempt)
      : undefined;
  if (!replacement) return undefined;
  if (
    boundSource ||
    (latest.id === replacement.id &&
      (current.state === "GENERATING" || replacement.state === "PENDING"))
  )
    return replacement;
  return undefined;
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
    source.attempt >= 3 ||
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
