import {
  PlanningShotsSchema,
  type PlanningRequest,
  type PlanningScript,
  type ShotSpec,
} from "@reelforge/contracts";
import { screenPlanningContent } from "./planning-guardrails.js";
export function validatePlanningShots(
  input: unknown,
  request: PlanningRequest,
  script?: PlanningScript,
): ShotSpec[] {
  const shots = PlanningShotsSchema.parse(input);
  if (
    Math.abs(
      shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) -
        request.brief.targetDurationSeconds,
    ) > 1
  )
    throw new Error("Shot duration mismatch");
  if (new Set(shots.map((shot) => shot.id)).size !== shots.length)
    throw new Error("Duplicate shot IDs");
  shots.forEach((shot, ordinal) => {
    if (
      shot.ordinal !== ordinal ||
      shot.workspaceId !== request.brief.workspaceId ||
      shot.runId !== request.runId ||
      shot.fps !== 24
    )
      throw new Error("Invalid shot identity or frame rate");
    if (shot.width !== 720 || shot.height !== 1280)
      throw new Error("Planning shots must be 720 × 1280");
    if (shot.dialogue.trim()) throw new Error("Speech must use channel narration TTS");
    if (
      shot.firstFrameFrom &&
      "previousShotOrdinal" in shot.firstFrameFrom &&
      shot.firstFrameFrom.previousShotOrdinal !== ordinal - 1
    )
      throw new Error("Chaining must use the preceding shot");
    screenPlanningContent(request, JSON.stringify(shot));
  });
  if (script) {
    const expected = [script.hook, ...script.beats, script.payoff, script.cta]
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    if (
      shots
        .map((shot) => shot.voLine)
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim() !== expected
    )
      throw new Error("Shots must preserve the script narration");
  }
  return shots;
}
