import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  ledgerUsd,
  reservationCents,
  secondsCost,
  ProviderFailure,
  SubmissionRefused,
  type ClipArtifact,
  type FailedJobStatus,
  type VideoGenPort,
  type Money,
} from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
import type { Prisma } from "@reelforge/database";
import type { Database } from "../identity/identity.types.js";
import type { PaidCallReservation } from "../usage-budget/usage-budget.types.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { hasDelivery, recordSubmissionRefusal } from "./routed-video-evidence.js";
import { lockBooks } from "../usage-budget/text-admission-lock.js";
import { decimalToMinor, minorToNumber } from "../usage-budget/usage-budget.money.js";

function routedBilledSeconds(usage: Prisma.JsonValue): number | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const { seconds } = usage;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

type LockedJob = {
  row: Prisma.ProviderRequestGetPayload<{
    include: { credits: { select: { amountMinor: true } } };
  }>;
  metadata: Prisma.JsonObject;
  reservation: Prisma.UsageReservationGetPayload<object> | null;
};

async function lockedJob(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  correlationId: string,
  jobId: string,
): Promise<LockedJob> {
  const where = { workspaceId_correlationId: { workspaceId, correlationId } };
  const scope = await tx.providerRequest.findUnique({
    where,
    select: { workspaceId: true, channelId: true },
  });
  if (!scope) throw new ConflictException("Provider ledger mismatch");
  await lockBooks(tx, scope);
  const row = await tx.providerRequest.findUniqueOrThrow({
    where,
    include: {
      credits: {
        where: { workspaceId, channelId: scope.channelId, currency: "USD", kind: "CREDIT" },
        select: { amountMinor: true },
      },
    },
  });
  const metadata = row.responseMetadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.providerJobId !== jobId
  )
    throw new ConflictException("Provider ledger metadata does not match the job receipt");
  const reservation = await tx.usageReservation.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey: `m08:${correlationId}` } },
  });
  if (
    (reservation?.id ?? null) !== metadata.reservationId ||
    (reservation &&
      (reservation.correlationId !== correlationId ||
        reservation.channelId !== scope.channelId ||
        reservation.currency !== row.currency ||
        reservation.category !== "VIDEO_MEDIA" ||
        Number(reservation.amountMinor) !== metadata.estimateMinor))
  )
    throw new ConflictException("Provider reservation mismatch");
  return { row, metadata, reservation };
}

type RoutedAdmission = {
  lock: string;
  correlations: readonly string[];
  authorize?: () => Promise<void>;
  replaces?: string;
};

@Injectable()
export class ProviderLedger {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly budgets: UsageBudgetService,
  ) {}
  public async assertReplaySafe(
    workspaceId: string,
    correlations: readonly string[],
    db: Prisma.TransactionClient = this.db,
  ): Promise<void> {
    const blocked = await db.providerRequest.findFirst({
      where: {
        workspaceId,
        correlationId: { in: [...correlations] },
        OR: [{ errorCode: null }, { errorCode: { not: "NOT_DISPATCHED" } }],
      },
    });
    if (blocked)
      throw new ConflictException("Provider submission already admitted; reconcile before replay");
  }

  public async confirmRefusal(
    workspaceId: string,
    correlationId: string,
    jobId: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const { row, metadata, reservation } = await lockedJob(tx, workspaceId, correlationId, jobId);
      if (hasDelivery(metadata) || (row.errorCode !== "REFUSED" && row.errorCode !== "PENDING"))
        throw new ConflictException("Provider refusal requires a matching job receipt");
      if (row.errorCode !== "REFUSED")
        await tx.providerRequest.update({ where: { id: row.id }, data: { errorCode: "REFUSED" } });
      if (reservation && routedBilledSeconds(row.usage) === null) {
        const credited = row.credits.reduce((sum, credit) => sum + credit.amountMinor, 0n);
        await this.budgets.commit(
          workspaceId,
          reservation.id,
          minorToNumber(reservation.amountMinor - credited),
          tx,
        );
      }
    });
  }

  public async submit(
    port: VideoGenPort,
    spec: ShotSpec,
    correlationId: string,
    channelId: string | null,
    idempotencyKey = correlationId,
    route?: RoutedAdmission,
  ): Promise<{ providerJobId: string }> {
    const estimate = port.estimate(spec);
    const reservation = await this.admit(port, spec, correlationId, channelId, estimate, route);
    try {
      const result = await port.submit(spec, `m08:${idempotencyKey}`);
      await this.db.providerRequest.update({
        where: { workspaceId_correlationId: { workspaceId: spec.workspaceId, correlationId } },
        data: {
          responseMetadata: {
            providerJobId: result.providerJobId,
            reservationId: reservation?.reservationId ?? null,
            estimateMinor: reservation?.estimateMinor ?? null,
          },
        },
      });
      return result;
    } catch (error) {
      if (error instanceof SubmissionRefused) {
        await this.db.$transaction((tx) =>
          recordSubmissionRefusal(
            tx,
            this.budgets,
            { workspaceId: spec.workspaceId, channelId, correlationId },
            reservation,
            port,
            error,
          ),
        );
        throw error;
      }
      const dispatched = !(error instanceof ProviderFailure) || error.dispatched;
      const refused =
        route &&
        error instanceof ProviderFailure &&
        error.dispatched &&
        error.kind === "REFUSAL" &&
        !error.http;
      await this.db.providerRequest.update({
        where: { workspaceId_correlationId: { workspaceId: spec.workspaceId, correlationId } },
        data: {
          errorCode: refused ? "REFUSED" : dispatched ? "UNCERTAIN" : "NOT_DISPATCHED",
          actualCost: dispatched ? (route ? null : ledgerUsd(estimate)) : "0",
        },
      });
      if (!route || !dispatched || refused)
        await this.budgets.finishPaidCall(reservation, {
          dispatched,
          actualCost: dispatched ? Number(ledgerUsd(estimate)) : null,
          actualCurrency: "USD",
        });
      throw error;
    }
  }
  private async admit(
    port: VideoGenPort,
    spec: ShotSpec,
    correlationId: string,
    channelId: string | null,
    estimate: Money,
    route?: RoutedAdmission,
  ): Promise<PaidCallReservation | null> {
    const capability = port.capabilities();
    const reserve = (
      transaction?: Prisma.TransactionClient,
    ): ReturnType<UsageBudgetService["reservePaidCall"]> =>
      this.budgets.reservePaidCall(
        {
          workspaceId: spec.workspaceId,
          channelId,
          correlationId,
          // This entry point accepts only VideoGenPort. Mixed VideoRun steps use runStepCategory.
          category: "VIDEO_MEDIA",
          currency: "USD",
          estimate: reservationCents(estimate) / 100,
        },
        transaction,
      );
    const intent = (
      db: Prisma.TransactionClient,
      held: PaidCallReservation | null,
    ): Promise<void> =>
      this.intent(
        spec,
        channelId,
        correlationId,
        capability.providerId,
        capability.modelId,
        estimate,
        db,
        held,
      );
    if (route)
      return this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${route.lock}, 0))`;
        await this.assertAdmission(tx, spec.workspaceId, channelId, capability.providerId, route);
        await route.authorize?.();
        const held = await reserve(tx);
        await intent(tx, held);
        return held;
      });
    const held = await reserve();
    try {
      await intent(this.db, held);
      return held;
    } catch {
      await this.budgets.finishPaidCall(held, { dispatched: false, actualCost: null });
      throw new ConflictException("Provider call already recorded or ledger unavailable");
    }
  }
  private async assertAdmission(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string | null,
    providerId: string,
    route: RoutedAdmission,
  ): Promise<void> {
    if (route.replaces) {
      await lockBooks(tx, { workspaceId, channelId });
      const refusal = await tx.providerRequest.findFirst({
        where: {
          workspaceId,
          correlationId: route.replaces,
          providerId,
          channelId,
          errorCode: "REFUSED",
          status: "FAILED",
        },
        select: { responseMetadata: true },
      });
      if (!refusal || hasDelivery(refusal.responseMetadata))
        throw new ConflictException("Provider rewrite requires a confirmed refusal");
    }
    await this.assertReplaySafe(
      workspaceId,
      route.correlations.filter((id) => id !== route.replaces),
      tx,
    );
  }
  private async intent(
    spec: ShotSpec,
    channelId: string | null,
    correlationId: string,
    providerId: string,
    modelId: string,
    estimate: Money,
    db: Prisma.TransactionClient,
    held: PaidCallReservation | null,
  ): Promise<void> {
    await db.providerRequest.create({
      data: {
        workspaceId: spec.workspaceId,
        channelId,
        correlationId,
        providerId,
        capabilityId: modelId,
        status: "FAILED",
        estimatedCost: ledgerUsd(estimate),
        currency: "USD",
        errorCode: "PENDING",
        responseMetadata: {
          reservationId: held?.reservationId ?? null,
          estimateMinor: held?.estimateMinor ?? null,
        },
      },
    });
  }
  public async finish(
    workspaceId: string,
    correlationId: string,
    port: VideoGenPort,
    artifact: Pick<ClipArtifact, "billedSeconds"> & Partial<ClipArtifact>,
    jobId: string,
    failure?: FailedJobStatus,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const { row, metadata, reservation } = await lockedJob(tx, workspaceId, correlationId, jobId);
      if (row.providerId !== port.capabilities().providerId || row.currency !== "USD")
        throw new ConflictException("Provider ledger mismatch");
      const rate = port.capabilities().pricePerSecond["720p"];
      const verified = artifact.billedSeconds !== null && rate !== null;
      const billed = verified ? ledgerUsd(secondsCost(artifact.billedSeconds!, rate!)) : null;
      const earlier = routedBilledSeconds(row.usage);
      const keepEarlier =
        earlier !== null &&
        row.actualCost !== null &&
        (billed === null || row.actualCost.gt(billed));
      const actual = keepEarlier ? row.actualCost!.toString() : billed;
      if (actual === null && row.credits.length && row.errorCode === "REFUSED")
        throw new ConflictException("A refunded refusal requires a verified bill to reprice");
      if (reservation && (actual !== null || reservation.status !== "COMMITTED")) {
        const amount =
          actual === null ? reservation.amountMinor : decimalToMinor(actual, reservation.currency);
        if (reservation.status === "COMMITTED") {
          // Verified billing supersedes the whole estimated posting, including its refund.
          await tx.usageReservation.update({
            where: { id: reservation.id },
            data: { committedMinor: amount },
          });
        } else {
          await this.budgets.commit(workspaceId, reservation.id, minorToNumber(amount), tx);
        }
      }
      // Billing is independent of delivery. Once a clip is saved, a later conflicting
      // refusal can still raise liability but must never reopen eligibility for a paid rewrite.
      const delivered = !failure && hasDelivery(artifact);
      const failed = failure && !hasDelivery(metadata);
      await tx.providerRequest.update({
        where: { id: row.id },
        data: {
          ...(delivered && { status: "SUCCEEDED", errorCode: null }),
          ...(failed && {
            status: "FAILED",
            errorCode: failure === "refused" ? "REFUSED" : "PROVIDER_JOB_FAILED",
          }),
          actualCost: actual,
          ...(verified && !keepEarlier && { usage: { seconds: artifact.billedSeconds } }),
          ...(delivered && {
            responseMetadata: {
              ...metadata,
              objectKey: artifact.objectKey!,
              checksumSha256: artifact.checksumSha256!,
            },
          }),
        },
      });
    });
  }
}
