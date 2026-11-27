import { readAdmissions } from "../usage-budget/run-admission-state.js";
import type { Run, Scoped, Transaction } from "./runs.types.js";

const denialMarker = "BUDGET_DENIED_NOT_DISPATCHED";

/** Explicit budget resume only. Never reopen a keyframe with evidence of dispatch. */
export async function rearmDeniedKeyframes(db: Scoped, tx: Transaction, run: Run): Promise<void> {
  const latest = await db.videoRunStep.findMany({
    where: { runId: run.id, key: { startsWith: "media:keyframe:" } },
    distinct: ["key"],
    orderBy: [{ key: "asc" }, { attempt: "desc" }],
    select: {
      id: true,
      runId: true,
      key: true,
      state: true,
      providerJobId: true,
      idempotencyKey: true,
      error: true,
      output: true,
    },
  });
  const candidates = latest.filter(
    (step) =>
      step.state === "CANCELLED" &&
      !step.providerJobId &&
      (step.output === null ||
        (typeof step.output === "object" &&
          "closedBy" in step.output &&
          step.output.closedBy === denialMarker)),
  );
  const legacy = candidates.filter((step) => step.output === null);
  // Older budget rollbacks left output null, but persisted the no-dispatch release event.
  const releases = legacy.length
    ? await db.runEvent.findMany({
        where: {
          runId: run.id,
          stepId: { in: legacy.map((step) => step.id) },
          type: "dispatch_released",
          payload: { path: ["reason"], equals: "NOT_DISPATCHED" },
        },
        select: { stepId: true },
      })
    : [];
  const released = new Set(releases.map(({ stepId }) => stepId));
  const admissions = await readAdmissions(db, tx, run.workspaceId, candidates);
  const ids = admissions
    .filter(
      ({ evidence, step }) =>
        evidence === "never-dispatched" && (step.output !== null || released.has(step.id)),
    )
    .map(({ step }) => step.id);
  if (!ids.length) return;
  await db.videoRunStep.updateMany({
    where: { runId: run.id, id: { in: ids }, state: "CANCELLED", providerJobId: null },
    data: { output: { closedBy: "NOT_DISPATCHED" } },
  });
}
