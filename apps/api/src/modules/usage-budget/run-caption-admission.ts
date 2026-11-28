import { ConflictException } from "@nestjs/common";
import {
  StoredPlanningScriptSchema,
  assertCaptionDuration,
  planningTranscript,
} from "@reelforge/contracts";
import { z } from "zod";
import { PLANNING_MANIFEST_KEY } from "../runs/run-outcomes.js";
import type { Run, Scoped, Step } from "../runs/runs.types.js";

import { SAVED_CAPTION_PLAN_UNUSABLE } from "../runs/run-render-stage.js";

export { SAVED_CAPTION_PLAN_UNUSABLE };

function savedCaptionRejection(): ConflictException {
  return new ConflictException({
    code: SAVED_CAPTION_PLAN_UNUSABLE,
    detail: "CAPTIONS_TOO_LONG",
    message: "Saved captions cannot fit. Start a new Short with shorter narration.",
  });
}

export function assertSavedCaptionFit(transcript: string, target: number, actual = Infinity): void {
  try {
    assertCaptionDuration(transcript, Math.min(target, 45, actual));
  } catch {
    throw savedCaptionRejection();
  }
}

const snapshot = z.object({
  brief: z.object({ targetDurationSeconds: z.number().positive() }),
});
const shot = z.object({ durationSeconds: z.number().positive() });
const shots = z.array(shot).min(1);
const writerReceipt = z.object({ result: z.object({ output: StoredPlanningScriptSchema }) });
const directorReceipt = z.object({ result: z.object({ output: shots }) });
const manifest = z.object({
  script: StoredPlanningScriptSchema,
  manifest: z.object({ shots }),
});
const duration = (list: z.infer<typeof shots>): number =>
  list.reduce((sum, item) => sum + item.durationSeconds, 0);

/** Admission only. Polling, fetching and settling previously submitted jobs skip this guard. */
export async function assertSavedCaptionAdmission(
  db: Scoped,
  run: Run,
  claims: readonly Step[],
): Promise<void> {
  const accepted = (key: string): Step | undefined =>
    claims
      .filter((step) => step.key === key && step.state === "SUCCEEDED")
      .reduce<Step | undefined>(
        (latest, step) => (!latest || step.attempt > latest.attempt ? step : latest),
        undefined,
      );
  const writer = accepted("media:text:scriptwriter");
  const receipt = accepted(PLANNING_MANIFEST_KEY);
  if (!writer && !receipt) return; // No saved script yet, including the first scriptwriter call.
  const records = await db.shotSpec.findMany({
    where: { runId: run.id },
    select: { document: true },
  });
  const director = accepted("media:text:director");
  try {
    const target = snapshot.parse(run.inputSnapshot).brief.targetDurationSeconds;
    const planned = receipt ? manifest.parse(receipt.output) : undefined;
    const script = writer ? writerReceipt.parse(writer.output).result.output : planned!.script;
    const directed = records.length
      ? shots.parse(records.map((row) => row.document))
      : (planned?.manifest.shots ??
        (director && directorReceipt.parse(director.output).result.output));
    assertSavedCaptionFit(planningTranscript(script), target, directed && duration(directed));
  } catch (error) {
    rejectInvalidSavedCaptionPlan(error);
  }
}

export function rejectInvalidSavedCaptionPlan(error: unknown): never {
  if (!(error instanceof z.ZodError)) throw error;
  throw new ConflictException(
    {
      code: SAVED_CAPTION_PLAN_UNUSABLE,
      detail: "MALFORMED_PLAN",
      message:
        "The saved plan is invalid and its captions could not be validated. Start a new Short.",
    },
    { cause: error },
  );
}
