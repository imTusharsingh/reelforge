import { lockVideoJob, mergeVideoEvidence } from "./video-job-evidence.js";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import { pendingCorrection, stageVideoReceipt } from "./run-pending-receipt.js";
import { DISPATCHING, OUTCOME_UNKNOWN } from "./run-admission-state.js";
import { lockBooks } from "./text-admission-lock.js";
import { reservationCents, secondsCost, type FailedJobStatus } from "@reelforge/ai-providers";
import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Run, Step, Transaction } from "../runs/runs.types.js";
import { savedVideoPricing } from "../scene-media/media-prices.js";
import { pendingShotMedia } from "./run-shot-receipt.js";

const observation = z.object({
  status: z.enum(["refused", "failed"]),
  providerJobId: z.string().min(1).nullable(),
  billedMinor: z.int().nonnegative().nullable(),
  billedSeconds: z.number().nonnegative().optional(),
});
export type TerminalVideo = z.infer<typeof observation>;

export function terminalVideo(step: Pick<Step, "key" | "output">): TerminalVideo | undefined {
  if (!step.key.startsWith("shot-")) return;
  const output = z.object({ terminalVideo: observation }).safeParse(step.output);
  return output.data?.terminalVideo;
}

export const terminalVideoWhere = {
  state: { in: ["RUNNING", "WAITING_EXTERNAL"] as ("RUNNING" | "WAITING_EXTERNAL")[] },
  OR: [
    { output: { path: ["terminalVideo", "status"], equals: "refused" } },
    { output: { path: ["terminalVideo", "status"], equals: "failed" } },
  ],
};

export function hasPublishedVideo(step: Step): boolean {
  return (
    step.state === "SUCCEEDED" ||
    (step.state === "WAITING_EXTERNAL" &&
      z.object({ storageArtifacts: z.array(z.unknown()).min(1) }).safeParse(step.output).success)
  );
}

export function hasVideoDelivery(step: Step): boolean {
  return (
    hasPublishedVideo(step) ||
    (step.state === "WAITING_EXTERNAL" &&
      !!(pendingCorrection(step)?.media ?? pendingShotMedia(step)?.pendingMedia))
  );
}

export function submissionBill(step: Step, seconds: number | null): number | null {
  if (seconds === null) return null;
  const price = savedVideoPricing(step.output);
  const cost = secondsCost(seconds, price.microUsdPerSecond);
  return reservationCents({ ...cost, microUsd: cost.microUsd + price.inputImageMicroUsd });
}

/** Remember the terminal outcome independently from a price-only receipt or media delivery. */
export async function stageTerminalVideo(
  store: RunsStore,
  context: Context,
  step: Step,
  status: FailedJobStatus,
  providerJobId: string | null,
  billedMinor: number | null,
  billedSeconds?: number | null,
  receipt?: VideoReceipt,
): Promise<Step> {
  const { value } = await store.mutate<{ step: Step; run: Run; bill: number | null }>(
    context,
    step.runId,
    "video_terminal_observed",
    async (db, run, tx) => {
      const current = await lockVideoJob(tx, db, run, step.id);
      if (current.idempotencyKey !== step.idempotencyKey || current.providerId !== step.providerId)
        throw new ConflictException("Terminal video receipt belongs to another attempt");
      const delivered = hasVideoDelivery(current);
      if (delivered || !["RUNNING", "WAITING_EXTERNAL"].includes(current.state)) {
        const saved =
          receipt && current.providerJobId && current.providerJobId === providerJobId
            ? await stageVideoReceipt(db, current, step, receipt)
            : current;
        return { value: { step: saved, run, bill: null }, payload: { replay: saved === current } };
      }
      const prior = matchedTerminal(current, step, providerJobId);
      const terminal = mergeTerminalObservation(prior, {
        status,
        providerJobId,
        billedMinor,
        ...(billedSeconds != null && { billedSeconds }),
      });
      const output = {
        ...z.record(z.string(), z.json()).parse(current.output ?? {}),
        terminalVideo: terminal,
      };
      await db.videoRunStep.updateMany({ where: { id: step.id }, data: { output } });
      return {
        value: {
          step: { ...current, output },
          run,
          bill: terminal.billedMinor === prior?.billedMinor ? null : terminal.billedMinor,
        },
        payload: { ...terminal },
        stepId: step.id,
      };
    },
  );
  // A budget lock timeout must not roll back provider evidence. Exposure also
  // counts the durable marker while these accounting writes are pending.
  if (value.bill !== null)
    await store.db.$transaction((tx) =>
      preserveTerminalExposure(tx, store, context, value.run, value.step, value.bill!),
    );
  return value.step;
}

function matchedTerminal(
  current: Step,
  observed: Step,
  providerJobId: string | null,
): TerminalVideo | undefined {
  if (
    current.providerJobId !== observed.providerJobId ||
    (current.state === "WAITING_EXTERNAL" && current.providerJobId !== providerJobId)
  )
    throw new ConflictException("Terminal video receipt belongs to another job");
  const prior = terminalVideo(current);
  if (prior && prior.providerJobId !== providerJobId)
    throw new ConflictException("Terminal video receipt changed remote job");
  return prior;
}

function terminalPrice(seen: TerminalVideo | undefined): VideoReceipt | null {
  if (seen?.billedMinor == null) return null;
  return {
    costMinor: seen.billedMinor,
    seconds: seen.billedSeconds ?? 0,
    costBasis: "BILLED",
    media: null,
    providerDurationSeconds: null,
    modelId: "",
    promptVersion: "",
  };
}

function mergeTerminalObservation(
  prior: TerminalVideo | undefined,
  seen: TerminalVideo,
): TerminalVideo {
  const merged = mergeVideoEvidence(
    { receipt: terminalPrice(prior), terminal: prior?.status },
    { receipt: terminalPrice(seen), terminal: seen.status },
  );
  const winner = merged.receipt?.costMinor === prior?.billedMinor ? prior : seen;
  return observation.parse({
    status: merged.terminal,
    providerJobId: seen.providerJobId,
    billedMinor: merged.receipt?.costMinor ?? null,
    billedSeconds: winner?.billedSeconds,
  });
}

async function preserveTerminalExposure(
  tx: Transaction,
  store: RunsStore,
  context: Context,
  run: Run,
  step: Step,
  amount: number,
): Promise<void> {
  // A crash can happen before committing the reservation. Raise its coverage now
  // and retain the billed row after expiry; do not create another posting.
  await tx.$queryRaw`SELECT id FROM video_runs WHERE workspace_id = ${run.workspaceId}::uuid AND id = ${run.id}::uuid FOR UPDATE`;
  const current = await lockVideoJob(tx, store.scoped(context, tx), run, step.id);
  if (current.idempotencyKey !== step.idempotencyKey) return;
  await lockBooks(tx, run);
  const scope = { workspaceId: run.workspaceId, channelId: run.channelId, correlationId: step.id };
  await tx.usageReservation.updateMany({
    where: {
      ...scope,
      idempotencyKey: `m08:${step.idempotencyKey}`,
      currency: "USD",
      category: "VIDEO_MEDIA",
      status: { in: ["RESERVED", "EXPIRED"] },
      amountMinor: { lt: BigInt(amount) },
    },
    data: { amountMinor: BigInt(amount) },
  });
  const cost = (amount / 100).toFixed(2);
  await tx.providerRequest.updateMany({
    where: {
      ...scope,
      providerId: step.providerId!,
      currency: "USD",
      errorCode: { in: [DISPATCHING, OUTCOME_UNKNOWN] },
      OR: [{ actualCost: null }, { actualCost: { lt: cost } }],
    },
    data: { actualCost: cost },
  });
}
