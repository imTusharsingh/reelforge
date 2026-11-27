import { ConflictException } from "@nestjs/common";
import {
  PlanningScriptSchema,
  assertCaptionDuration,
  planningTranscript,
} from "@reelforge/contracts";
import { z } from "zod";
import { PLANNING_MANIFEST_KEY } from "../runs/run-outcomes.js";
import type { Run, Scoped, Step } from "../runs/runs.types.js";

const snapshot = z.object({
  brief: z.object({ targetDurationSeconds: z.number().positive() }),
});
const shot = z.object({ durationSeconds: z.number().positive() });
const shots = z.array(shot).min(1);
const writerReceipt = z.object({ result: z.object({ output: PlanningScriptSchema }) });
const directorReceipt = z.object({ result: z.object({ output: shots }) });
const manifest = z.object({
  script: PlanningScriptSchema,
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
    assertCaptionDuration(
      planningTranscript(script),
      Math.min(target, 45, directed ? duration(directed) : Infinity),
    );
  } catch {
    throw new ConflictException({
      code: "SAVED_CAPTION_PLAN_UNUSABLE",
      message:
        "Saved captions cannot be validated for this run. Start a new Short with shorter narration.",
    });
  }
}
