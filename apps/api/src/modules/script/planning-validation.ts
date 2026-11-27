import {
  PlanningShotsSchema,
  assertCaptionDuration,
  planningTranscript,
  type PlanningRequest,
  type PlanningScript,
  type ShotSpec,
} from "@reelforge/contracts";
import { screenPlanningContent } from "./planning-guardrails.js";
export function fitsAssemblyDuration(shots: readonly ShotSpec[], targetSeconds: number): boolean {
  const seconds = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  return seconds >= 30 && seconds <= 45 && Math.abs(seconds - targetSeconds) <= 1;
}
export function validatePlanningShots(
  input: unknown,
  request: PlanningRequest,
  script?: PlanningScript,
): ShotSpec[] {
  const shots = PlanningShotsSchema.parse(input);
  if (!fitsAssemblyDuration(shots, request.brief.targetDurationSeconds))
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
    const transcript = planningTranscript(script);
    assertCaptionDuration(
      transcript,
      shots.reduce((sum, shot) => sum + shot.durationSeconds, 0),
    );
    const expected = transcript.replace(/\s+/gu, " ").trim();
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
