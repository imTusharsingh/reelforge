import { z } from "zod";
import type { Client } from "pg";
import { withSessionLock } from "../runs/session-lock.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Step } from "../runs/runs.types.js";
import {
  DISPATCHING,
  OUTCOME_UNKNOWN,
  readAdmission,
  TEXT_DISPATCH_PROTOCOL,
  TEXT_PREPARED,
} from "./run-admission-state.js";
import { remainingSubmissionHold, submissionHold } from "../runs/run-outcomes.js";

import { releaseAdmission } from "./run-paid-admission.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

const lockKey = (step: Step): string => `sync-text:${step.id}`;
export function withTextDispatch<T>(
  step: Step,
  work: (check: TextDispatchCheck) => Promise<T>,
): Promise<T> {
  return withSessionLock(
    lockKey(step),
    "rf-sync-text",
    "Text dispatch in progress",
    "Text dispatcher lost ownership",
    (check, session) => work(Object.assign(check, { arm: (step: Step) => armText(session, step) })),
  );
}

export type TextDispatchCheck = (() => Promise<void>) & { arm?: (step: Step) => Promise<boolean> };

async function armText(session: Client, step: Step): Promise<boolean> {
  const result = await session.query(
    `UPDATE provider_requests
     SET error_code = $1, response_metadata = $2::jsonb
     WHERE workspace_id = $3 AND correlation_id = $4 AND error_code = $5
       AND response_metadata->>'textDispatchProtocol' = $6
       AND EXISTS (
         SELECT 1 FROM usage_reservations r
         WHERE r.workspace_id = $3 AND r.idempotency_key = $7
           AND r.correlation_id = $4 AND r.status = 'RESERVED' AND r.expires_at > clock_timestamp()
       )`,
    [
      DISPATCHING,
      JSON.stringify({
        dispatched: true,
        costKnown: false,
        textDispatchProtocol: TEXT_DISPATCH_PROTOCOL,
      }),
      step.workspaceId,
      step.id,
      TEXT_PREPARED,
      TEXT_DISPATCH_PROTOCOL,
      `m08:${step.idempotencyKey}`,
    ],
  );
  return result.rowCount === 1;
}

const preparedProtocol = z.object({ textDispatchProtocol: z.literal(TEXT_DISPATCH_PROTOCOL) });

class ActiveOrSettled extends Error {}

/** A session lock dies with its worker. Take the same lock before fencing the
 * ledger marker, so a slow but live POST can still finish normally. */
export async function recoverTextDispatches(
  store: RunsStore,
  context: Context,
  usage: Pick<UsageBudgetService, "release">,
): Promise<void> {
  const requests = await store.db.providerRequest.findMany({
    // Older protocols may mark a preparation as sent. Never infer their outcome.
    where: {
      workspaceId: context.workspaceId,
      errorCode: { in: [DISPATCHING, TEXT_PREPARED] },
      responseMetadata: { path: ["textDispatchProtocol"], equals: TEXT_DISPATCH_PROTOCOL },
    },
    select: { correlationId: true },
  });
  if (!requests.length) return;
  const steps = await store.scoped(context).videoRunStep.findMany({
    where: {
      id: { in: requests.map((r) => r.correlationId) },
      key: { startsWith: "media:text:" },
      state: "RUNNING",
      providerJobId: null,
    },
  });
  for (const step of steps) await recoverOne(store, context, usage, step);
}

async function recoverOne(
  store: RunsStore,
  context: Context,
  usage: Pick<UsageBudgetService, "release">,
  step: Step,
): Promise<void> {
  try {
    await store.mutate(context, step.runId, "reconcile_required", async (db, run, tx) => {
      const [lock] = await tx.$queryRaw<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey(step)},0)) AS acquired`;
      if (!lock?.acquired) throw new ActiveOrSettled();
      const current = await db.videoRunStep.findFirst({
        where: { id: step.id, state: "RUNNING", providerJobId: null },
      });
      if (!current) throw new ActiveOrSettled();
      const admission = await readAdmission(tx, context, current);
      if (
        admission.evidence === "text-prepared" &&
        admission.reservation &&
        ["RESERVED", "EXPIRED"].includes(admission.reservation.status) &&
        preparedProtocol.safeParse(admission.request?.responseMetadata).success
      ) {
        const amountMinor = await releaseAdmission(
          db,
          tx,
          usage,
          context,
          run,
          current,
          admission.reservation.id,
          false,
          true,
        );
        return {
          value: null,
          payload: { amountMinor, reason: "NOT_DISPATCHED", orphanedPreparation: true },
          eventType: "dispatch_released",
          stepId: step.id,
        };
      }
      const changed = await tx.providerRequest.updateMany({
        where: {
          workspaceId: context.workspaceId,
          correlationId: step.id,
          errorCode: DISPATCHING,
          responseMetadata: { path: ["textDispatchProtocol"], equals: TEXT_DISPATCH_PROTOCOL },
        },
        data: { errorCode: OUTCOME_UNKNOWN },
      });
      if (!changed.count) throw new ActiveOrSettled();
      const reason = (await remainingSubmissionHold(db, tx, run)) ?? submissionHold(step.id);
      if (!run.pauseReason || run.pauseReason.startsWith("RECONCILE_REQUIRED"))
        await db.videoRun.updateMany({ where: { id: run.id }, data: { pauseReason: reason } });
      return { value: null, payload: { reason, orphanedDispatch: true }, stepId: step.id };
    });
  } catch (error) {
    if (!(error instanceof ActiveOrSettled)) throw error;
  }
}
