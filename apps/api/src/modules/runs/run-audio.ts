import { jobIdFromAdmission, readAdmissions } from "../usage-budget/run-admission-state.js";
import type { Run, Scoped, Step, Transaction } from "./runs.types.js";

export const AUDIO_KEYS = ["media:narration", "media:music"];

export async function acceptedAudio(db: Scoped, tx: Transaction, run: Run): Promise<Step[]> {
  const active = await db.videoRunStep.findMany({
    where: {
      runId: run.id,
      key: { in: AUDIO_KEYS },
      state: { in: ["WAITING_EXTERNAL", "RUNNING"] },
    },
  });
  const unattached = active.filter((step) => step.state === "RUNNING" && !step.providerJobId);
  const admissions = await readAdmissions(db, tx, run.workspaceId, unattached);
  return [
    ...active.filter((step) => step.state === "WAITING_EXTERNAL" && step.providerJobId),
    ...admissions.filter((admission) => jobIdFromAdmission(admission)).map(({ step }) => step),
  ];
}

export function failedAudio(db: Scoped, runId: string): Promise<Step | null> {
  return db.videoRunStep.findFirst({
    where: { runId, key: { in: AUDIO_KEYS }, state: "FAILED" },
    orderBy: { key: "asc" },
  });
}
