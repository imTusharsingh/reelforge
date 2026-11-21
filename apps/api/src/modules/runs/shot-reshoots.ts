import { z } from "zod";
import type { Scoped, Step } from "./runs.types.js";

const request = z.object({ ordinal: z.int().nonnegative(), attempt: z.int().positive() });

export async function shotReshoots(
  db: Scoped,
  runId: string,
): Promise<{ key: string; attempt: number }[]> {
  const events = await db.runEvent.findMany({
    where: { runId, type: "reshoot_requested" },
    select: { payload: true },
  });
  return events.map(({ payload }) => {
    const { ordinal, attempt } = request.parse(payload);
    return { key: `shot-${ordinal}`, attempt };
  });
}

/** A refused or abandoned reshoot can produce its usable clip on a later physical attempt. */
export function completedRedos(
  steps: Step[],
  requests: Awaited<ReturnType<typeof shotReshoots>>,
): Step[] {
  const successes = steps
    .filter((step) => step.state === "SUCCEEDED")
    .sort((a, b) => a.attempt - b.attempt);
  return [
    ...successes.filter((step) => step.key === "REEDIT"),
    ...requests.flatMap(
      (request) =>
        successes.find((step) => step.key === request.key && step.attempt >= request.attempt) ?? [],
    ),
  ];
}
