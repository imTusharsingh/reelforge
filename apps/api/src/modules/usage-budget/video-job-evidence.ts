import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import type { Run, Scoped, Step, Transaction } from "../runs/runs.types.js";

type Price = Pick<VideoReceipt, "costMinor"> & {
  costBasis?: VideoReceipt["costBasis"] | undefined;
};

/** Historical unmarked prices can include provider reports; preserve them on ambiguous replays. */
export function winsVideoPrice(previous: Price | undefined, incoming: Price): boolean {
  return (
    !previous ||
    (incoming.costBasis === "BILLED" &&
      (previous.costBasis === "RESERVATION" || incoming.costMinor > previous.costMinor))
  );
}

type Observation = {
  receipt: VideoReceipt | null;
  terminal?: "refused" | "failed" | undefined;
  delivered?: boolean;
};

/** Merge evidence, not accounting side effects. The winning price carries its own seconds. */
export function mergeVideoEvidence(previous: Observation, incoming: Observation): Observation {
  const old = previous.receipt;
  const next = incoming.receipt;
  const price = next && winsVideoPrice(old ?? undefined, next) ? next : old;
  const media = next?.media ?? old?.media ?? null;
  const delivered = !!(media || previous.delivered || incoming.delivered);
  return {
    receipt: price && { ...price, media, providerDurationSeconds: media?.durationSeconds ?? null },
    delivered,
    terminal: delivered ? undefined : (previous.terminal ?? incoming.terminal),
  };
}

export function sameVideoClip(a: VideoReceipt["media"], b: VideoReceipt["media"]): boolean {
  return a?.objectKey === b?.objectKey && a?.checksumSha256 === b?.checksumSha256;
}

/** Called under the run revision lock, before locking any budget or request rows. */
export async function lockVideoJob(
  tx: Transaction,
  db: Scoped,
  run: Pick<Run, "id" | "workspaceId">,
  stepId: string,
): Promise<Step> {
  await tx.$queryRaw`
    SELECT id FROM video_run_steps
    WHERE workspace_id = ${run.workspaceId}::uuid AND run_id = ${run.id}::uuid
      AND id = ${stepId}::uuid FOR UPDATE
  `;
  return db.videoRunStep.findFirstOrThrow({ where: { id: stepId, runId: run.id } });
}
