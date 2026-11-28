import { Prisma } from "@reelforge/database";
import type { Step, Transaction } from "../runs/runs.types.js";
import { legacyObject } from "./legacy-text-import-fields.js";
import { pricedOutput } from "./run-shot-receipt.js";

type MediaRequest = Prisma.ProviderRequestGetPayload<object>;
type MediaReservation = Prisma.UsageReservationGetPayload<object>;

export async function mainVideoEstimate(
  tx: Transaction,
  row: { id: string; correlationId: string; status: string; errorCode: string | null },
  reservation: MediaReservation | undefined,
): Promise<{
  gross: string;
  minor: number;
  metadata: ReturnType<typeof legacyObject>;
  shot: boolean;
} | null> {
  if (row.status !== "SUCCEEDED" || row.errorCode !== null) return null;
  const request = await tx.providerRequest.findUniqueOrThrow({ where: { id: row.id } });
  if (
    request.currency !== "USD" ||
    (reservation &&
      (reservation.category !== "VIDEO_MEDIA" ||
        reservation.currency !== request.currency ||
        reservation.channelId !== request.channelId))
  )
    return null;
  const metadata = legacyObject(request.responseMetadata);
  const step = await tx.videoRunStep.findFirst({
    where: { workspaceId: request.workspaceId, id: row.correlationId },
  });
  const shot =
    !!step &&
    !!reservation &&
    mainShotEstimate(step, reservation.idempotencyKey, request.providerId);
  const routed = !step && (await mainRoutedEstimate(tx, request, metadata, reservation));
  if (!shot && !routed) return null;
  const booked =
    request.actualCost ??
    (typeof metadata.legacyEstimateMinor === "number"
      ? routed
        ? request.estimatedCost
        : new Prisma.Decimal(metadata.legacyEstimateMinor).div(100)
      : null);
  if (
    !booked ||
    (shot && !booked.mul(100).equals(step.costMinor!)) ||
    (routed && !request.estimatedCost?.equals(booked))
  )
    return null;
  const minor = Math.round(booked.mul(100).toNumber());
  if (
    !Number.isSafeInteger(minor) ||
    minor < 0 ||
    (request.actualCost === null && metadata.legacyEstimateMinor !== minor)
  )
    return null;
  return { gross: booked.toString(), minor, metadata, shot };
}

async function mainRoutedEstimate(
  tx: Transaction,
  request: MediaRequest,
  metadata: ReturnType<typeof legacyObject>,
  reservation: MediaReservation | undefined,
): Promise<boolean> {
  if (
    legacyObject(request.usage).seconds !== null ||
    typeof metadata.providerJobId !== "string" ||
    !metadata.providerJobId
  )
    return false;
  if (reservation)
    return (
      reservation.idempotencyKey === `m08:${request.correlationId}` &&
      metadata.reservationId === reservation.id &&
      metadata.estimateMinor === Number(reservation.amountMinor)
    );
  // Main's routed ledger explicitly wrote null reservation fields and stored the
  // artifact before recording a successful estimate for unbudgeted workspaces.
  return (
    metadata.reservationId === null &&
    metadata.estimateMinor === null &&
    typeof metadata.objectKey === "string" &&
    !!metadata.objectKey &&
    typeof metadata.checksumSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(metadata.checksumSha256) &&
    !(await tx.usageReservation.findFirst({
      where: { workspaceId: request.workspaceId, correlationId: request.correlationId },
      select: { id: true },
    }))
  );
}

function mainShotEstimate(step: Step, key: string, providerId: string): boolean {
  const saved = pricedOutput.safeParse(step.output).data?.receipt;
  return (
    step.key.startsWith("shot-") &&
    step.state === "SUCCEEDED" &&
    step.providerId === providerId &&
    !!step.providerJobId &&
    saved?.providerJobId === step.providerJobId &&
    saved.costBasis === "RESERVATION" &&
    saved.costMinor === step.costMinor &&
    key === `m08:${step.idempotencyKey}`
  );
}
