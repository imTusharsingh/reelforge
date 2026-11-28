import {
  ledgerUsd,
  secondsCost,
  type ClipArtifact,
  type SubmissionRefused,
  type VideoGenPort,
} from "@reelforge/ai-providers";
import type { Prisma } from "@reelforge/database";
import { lockBooks } from "../usage-budget/text-admission-lock.js";
import { decimalToMinor, minorToNumber } from "../usage-budget/usage-budget.money.js";
import type { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import type { PaidCallReservation } from "../usage-budget/usage-budget.types.js";

export function hasDelivery(value: Prisma.JsonValue | Partial<ClipArtifact>): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "objectKey" in value &&
    typeof value.objectKey === "string" &&
    !!value.objectKey &&
    "checksumSha256" in value &&
    typeof value.checksumSha256 === "string" &&
    !!value.checksumSha256
  );
}

export async function recordSubmissionRefusal(
  tx: Prisma.TransactionClient,
  budgets: Pick<UsageBudgetService, "commit">,
  {
    workspaceId,
    channelId,
    correlationId,
  }: {
    workspaceId: string;
    channelId: string | null;
    correlationId: string;
  },
  reservation: PaidCallReservation | null,
  port: VideoGenPort,
  refusal: SubmissionRefused,
): Promise<void> {
  const rate = port.capabilities().pricePerSecond["720p"];
  const seconds = refusal.billedSeconds;
  const actualCost =
    seconds !== null && rate !== null ? ledgerUsd(secondsCost(seconds, rate)) : null;
  await lockBooks(tx, { workspaceId, channelId });
  if (reservation)
    await budgets.commit(
      workspaceId,
      reservation.reservationId,
      actualCost === null
        ? reservation.estimateMinor
        : minorToNumber(decimalToMinor(actualCost, "USD")),
      tx,
    );
  await tx.providerRequest.update({
    where: { workspaceId_correlationId: { workspaceId, correlationId } },
    data: {
      status: "FAILED",
      errorCode: "REFUSED",
      actualCost,
      ...(actualCost !== null && { usage: { seconds } }),
      responseMetadata: {
        reservationId: reservation?.reservationId ?? null,
        estimateMinor: reservation?.estimateMinor ?? null,
        ...(refusal.providerJobId && { providerJobId: refusal.providerJobId }),
      },
    },
  });
}
