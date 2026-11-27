import { completedRedos, shotReshoots } from "../runs/shot-reshoots.js";
import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { AssemblyInterrupted } from "../orchestration/video-run.handlers.js";
import type { Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import { readAdmissions, canRollback } from "./run-admission-state.js";

export const criticPrefix = "media:text:critic:";

/** Only gate new paid work; accepted critic receipts may still be collected and settled. */
export function assertCriticAdmissionOpen(run: Run, key: string): void {
  if (!key.startsWith(criticPrefix)) return;
  if (run.state !== "CRITIC") throw new ConflictException("Critic assembly revision changed");
  if (run.pauseReason) throw new AssemblyInterrupted(null);
}

export async function openCritics(
  db: Scoped,
  tx: Transaction,
  run: Run,
): ReturnType<typeof readAdmissions<Step>> {
  const steps = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      key: { startsWith: criticPrefix },
      state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
    },
  });
  return readAdmissions(db, tx, run.workspaceId, steps);
}

/** Checked while holding the same run revision as operator edits and the dispatch marker. */
export async function assertCriticRevision(
  db: Scoped,
  tx: Transaction,
  run: Run,
  step: { key: string; input: unknown; id?: string },
): Promise<void> {
  if (!step.key.startsWith(criticPrefix)) return;
  assertCriticAdmissionOpen(run, step.key);
  const input = z
    .object({ spec: z.object({ assemblyRevision: z.int().positive() }) })
    .safeParse(step.input);
  const changes = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      OR: [{ key: "REEDIT" }, { key: { startsWith: "shot-" }, attempt: { gt: 1 } }],
    },
    select: { key: true, state: true, attempt: true },
  });
  const revision = 1 + completedRedos(changes, await shotReshoots(db, run.id)).length;
  if (
    changes.some((s) => s.key === "REEDIT" && s.state !== "SUCCEEDED") ||
    !input.success ||
    input.data.spec.assemblyRevision !== revision ||
    step.key !== criticPrefix + revision
  )
    throw new ConflictException("Critic assembly revision changed");
  const others = (await openCritics(db, tx, run)).filter(({ step: other }) => other.id !== step.id);
  if (others.some((other) => !canRollback(other)))
    throw new ConflictException("Reconcile the prior critic before dispatch");
}
