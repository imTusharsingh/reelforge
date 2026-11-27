import { ConflictException } from "@nestjs/common";
import type { Context, Step, Transaction } from "../runs/runs.types.js";
import { json } from "../runs/runs.types.js";
import {
  canConfirmRejection,
  DISPATCHING,
  OUTCOME_UNKNOWN,
  readAdmission,
} from "./run-admission-state.js";
import type { UsageBudgetService } from "./usage-budget.service.js";

type Failure = {
  message: string;
  dispatched: boolean;
  cost: number;
  providerJobId: string | null;
  usage?: Record<string, unknown>;
};
export async function settleFailedRequest(
  ledger: Pick<UsageBudgetService, "commit" | "release">,
  tx: Transaction,
  context: Context,
  step: Step,
  { message, dispatched, cost, providerJobId, usage }: Failure,
): Promise<void> {
  if (step.key.startsWith("media:text:"))
    throw new ConflictException("Text settlement requires its evidence journal");
  if (!dispatched && !canConfirmRejection(await readAdmission(tx, context, step)))
    throw new ConflictException("Paid dispatch outcome changed");
  const code =
    usage !== undefined
      ? "PROVIDER_INVALID_OUTPUT"
      : dispatched
        ? "PROVIDER_JOB_FAILED"
        : "NOT_DISPATCHED";
  const updated = await tx.providerRequest.updateMany({
    where: {
      workspaceId: context.workspaceId,
      correlationId: step.id,
      errorCode: dispatched ? { in: [DISPATCHING, OUTCOME_UNKNOWN] } : DISPATCHING,
    },
    data: {
      status: "FAILED",
      actualCost: dispatched ? null : 0,
      ...(usage !== undefined ? { usage: json(usage) } : {}),
      responseMetadata: {
        dispatched,
        costKnown: !dispatched,
        ...(providerJobId && providerJobId !== step.idempotencyKey ? { providerJobId } : {}),
      },
      errorCode: code,
      errorMessage: message,
    },
  });
  if (updated.count !== 1) throw new ConflictException("Paid dispatch outcome changed");
  const reservation = await tx.usageReservation.findFirstOrThrow({
    where: { workspaceId: context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
  });
  if (dispatched) await ledger.commit(context.workspaceId, reservation.id, cost, tx);
  else await ledger.release(context.workspaceId, reservation.id, code, tx);
}
