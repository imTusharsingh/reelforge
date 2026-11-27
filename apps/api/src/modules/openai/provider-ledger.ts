import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  ledgerUsd,
  reservationCents,
  secondsCost,
  ProviderFailure,
  type ClipArtifact,
  type VideoGenPort,
  type Money,
} from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
import type { Prisma } from "@reelforge/database";
import type { Database } from "../identity/identity.types.js";
import type { PaidCallReservation } from "../usage-budget/usage-budget.types.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";

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
      const marked = await tx.providerRequest.updateMany({
        where: {
          workspaceId,
          correlationId,
          errorCode: { in: ["PENDING", "REFUSED"] },
          responseMetadata: { path: ["providerJobId"], equals: jobId },
        },
        data: { errorCode: "REFUSED" },
      });
      if (marked.count !== 1)
        throw new ConflictException("Provider refusal requires a matching job receipt");
      const reservation = await tx.usageReservation.findFirst({
        where: { workspaceId, correlationId },
      });
      if (reservation)
        await this.budgets.commit(workspaceId, reservation.id, Number(reservation.amountMinor), tx);
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
        await this.assertAdmission(tx, spec.workspaceId, capability.providerId, route);
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
    providerId: string,
    route: RoutedAdmission,
  ): Promise<void> {
    if (route.replaces) {
      const refusal = await tx.providerRequest.findFirst({
        where: {
          workspaceId,
          correlationId: route.replaces,
          providerId,
          errorCode: "REFUSED",
        },
      });
      if (!refusal) throw new ConflictException("Provider rewrite requires a confirmed refusal");
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
    artifact: ClipArtifact,
  ): Promise<void> {
    const row = await this.db.providerRequest.findUnique({
      where: { workspaceId_correlationId: { workspaceId, correlationId } },
    });
    if (!row || row.providerId !== port.capabilities().providerId)
      throw new ConflictException("Provider ledger mismatch");
    const metadata = row.responseMetadata;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
      throw new ConflictException("Provider ledger metadata missing");
    const rate = port.capabilities().pricePerSecond["720p"];
    const actual =
      artifact.billedSeconds === null || rate === null
        ? row.estimatedCost!.toString()
        : ledgerUsd(secondsCost(artifact.billedSeconds, rate));
    await this.db.providerRequest.update({
      where: { workspaceId_correlationId: { workspaceId, correlationId } },
      data: {
        status: "SUCCEEDED",
        actualCost: actual,
        errorCode: null,
        usage: { seconds: artifact.billedSeconds },
        responseMetadata: {
          ...metadata,
          objectKey: artifact.objectKey,
          checksumSha256: artifact.checksumSha256,
        },
      },
    });
    const reservation =
      typeof metadata.reservationId === "string" && typeof metadata.estimateMinor === "number"
        ? {
            workspaceId,
            reservationId: metadata.reservationId,
            currency: "USD",
            estimateMinor: metadata.estimateMinor,
          }
        : null;
    await this.budgets.finishPaidCall(reservation, {
      dispatched: true,
      actualCost: Number(actual),
      actualCurrency: "USD",
    });
  }
}
