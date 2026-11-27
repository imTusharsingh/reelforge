import { VideoRunStateSchema, type VideoRunState } from "@reelforge/contracts";
import { z } from "zod";
import type { Scoped } from "./runs.types.js";

const transitions = z.object({from:VideoRunStateSchema, to:VideoRunStateSchema});
const stages = VideoRunStateSchema.options.slice(0, VideoRunStateSchema.options.indexOf("LEARNING")+1);
export async function completedStages(db: Scoped, runId: string):Promise<VideoRunState[]> {
  const events = await db.runEvent.findMany({
    where:{runId, payload:{path:["from"],string_starts_with:""}},
    orderBy:{sequence:"asc"},select:{payload:true},
  });
  const completed = new Set<VideoRunState>();
  for (const {payload} of events) {
    const edge = transitions.safeParse(payload).data;
    if (!edge || edge.from === edge.to || !stages.includes(edge.to)) continue;
    const destination = stages.indexOf(edge.to);
    // Returning to production invalidates the superseded pass through later stages.
    for (const stage of stages.slice(destination)) completed.delete(stage);
    if (stages.includes(edge.from) && stages.indexOf(edge.from) < destination) completed.add(edge.from);
  }
  return [...completed];
}
