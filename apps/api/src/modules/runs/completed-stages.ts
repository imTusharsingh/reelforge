import { VideoRunStateSchema, type VideoRunState } from "@reelforge/contracts";
import { z } from "zod";
import type { Scoped } from "./runs.types.js";

const transition = z.object({ from: VideoRunStateSchema, to: VideoRunStateSchema });
const stages = VideoRunStateSchema.options.slice(
  0,
  VideoRunStateSchema.options.indexOf("LEARNING") + 1,
);
// These legacy lifecycle events record a transition without a from/to payload.
const recordedEdges = {
  approved: { from: "AWAITING_APPROVAL", to: "SCHEDULED" },
  auto_approved: { from: "AWAITING_APPROVAL", to: "SCHEDULED" },
  publish_dry_run: { from: "SCHEDULED", to: "PUBLISHED" },
} as const;
const eventType = z.enum(["approved", "auto_approved", "publish_dry_run"]);

export async function completedStages(
  db: Scoped,
  runId: string,
  revision: number,
): Promise<VideoRunState[]> {
  const events = await db.runEvent.findMany({
    where: {
      runId,
      sequence: { lte: revision },
      OR: [
        { type: { in: eventType.options } },
        { payload: { path: ["from"], string_starts_with: "" } },
      ],
    },
    orderBy: { sequence: "asc" },
    select: { type: true, payload: true },
  });
  const completed = new Set<VideoRunState>();
  for (const event of events) {
    const known = eventType.safeParse(event.type).data;
    const edge = known ? recordedEdges[known] : transition.safeParse(event.payload).data;
    if (!edge || edge.from === edge.to) continue;
    const source = stages.indexOf(edge.from);
    const destination = stages.indexOf(edge.to);
    // Pauses and failures do not prove their source stage completed.
    if (destination < 0) continue;
    // A rewind invalidates completion in the superseded pass, including the stage being re-entered.
    for (const stage of stages.slice(destination)) completed.delete(stage);
    if (source >= 0 && source < destination) completed.add(edge.from);
  }
  return [...completed];
}
