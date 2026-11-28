import { z } from "zod";
import { json, type Scoped, type Step } from "../runs/runs.types.js";

type Charge = Pick<Step, "id" | "key" | "output" | "costMinor" | "state">;

/** Called under the run lock. Preserve the receipt when marking it booked. */
async function markAccounted(db: Scoped, steps: Charge[]): Promise<void> {
  for (const step of steps) {
    if (step.state !== "SUCCEEDED" || !step.key.startsWith("media:")) continue;
    const output = z.record(z.string(), z.unknown()).parse(step.output ?? {});
    if (output.budgetAccounted !== true)
      await db.videoRunStep.updateMany({
        where: { id: step.id },
        data: { output: json({ ...output, budgetAccounted: true }) },
      });
  }
}

export async function settledMediaSpend(
  db: Scoped,
  runId: string,
  planningOnly = false,
): Promise<number> {
  const prefixes = planningOnly ? ["media:text:", "media:reference:"] : ["shot-", "media:"];
  const steps = await db.videoRunStep.findMany({
    where: {
      runId,
      AND: [
        { OR: prefixes.map((startsWith) => ({ key: { startsWith } })) },
        {
          OR: [
            { state: { in: ["SUCCEEDED", "FAILED", "SKIPPED"] } },
            { textProjection: { isNot: null } },
          ],
        },
      ],
    },
    select: {
      id: true,
      key: true,
      output: true,
      costMinor: true,
      state: true,
      textProjection: { select: { netMinor: true } },
    },
  });
  await markAccounted(db, steps);
  return steps.reduce(
    (total, step) => total + (step.textProjection?.netMinor ?? step.costMinor ?? 0),
    0,
  );
}
