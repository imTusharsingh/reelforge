import { PlanningShotsSchema, type PlanningRequest, type ShotSpec } from "@reelforge/contracts";
import type { WorkspaceContext } from "../identity/identity.types.js";
import type { ReferenceLibrary } from "../reference-library/planning.ports.js";
import {
  planningReferencePins,
  referencePins,
  selectReferences,
} from "../reference-library/reference-selection.js";

/** Resolve defaults once per run; every shot receives immutable pins for its manifest. */
export async function pinPlanningShots(
  context: WorkspaceContext,
  request: PlanningRequest,
  input: readonly ShotSpec[],
  library: Pick<ReferenceLibrary, "defaults" | "resolve">,
): Promise<ShotSpec[]> {
  if (request.brief.workspaceId !== context.workspaceId) throw new Error("Foreign Brief");
  const shots = PlanningShotsSchema.parse(input);
  const defaults = await library.defaults(context, request.brief.channelId);
  const pins = planningReferencePins(defaults, request.brief);
  const references = referencePins(selectReferences(await library.resolve(context, pins)));
  return shots.map((shot) => {
    if (shot.workspaceId !== context.workspaceId || shot.runId !== request.runId)
      throw new Error("Foreign shot");
    return { ...shot, references };
  });
}
