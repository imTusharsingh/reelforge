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
import type { Database } from "../identity/identity.types.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";

@Injectable()
export class ProviderLedger {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly budgets: UsageBudgetService,
  ) {}
  public async submit(
    port: VideoGenPort,
    spec: ShotSpec,
    correlationId: string,
    channelId: string | null,
    idempotencyKey = correlationId,
  ): Promise<{ providerJobId: string }> {
    const capability = port.capabilities();
    const estimate = port.estimate(spec);
    const reservation = await this.budgets.reservePaidCall({
      workspaceId: spec.workspaceId,
      channelId,
      correlationId,
      category: "VIDEO_MEDIA",
      currency: "USD",
      estimate: reservationCents(estimate) / 100,
    });
    try {
      await this.intent(
        spec,
        channelId,
        correlationId,
        capability.providerId,
        capability.modelId,
        estimate,
      );
    } catch {
      await this.budgets.finishPaidCall(reservation, { dispatched: false, actualCost: null });
      throw new ConflictException("Provider call already recorded or ledger unavailable");
    }
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
      await this.db.providerRequest.update({
        where: { workspaceId_correlationId: { workspaceId: spec.workspaceId, correlationId } },
        data: {
          errorCode: dispatched ? "UNCERTAIN" : "NOT_DISPATCHED",
          actualCost: dispatched ? ledgerUsd(estimate) : "0",
        },
      });
      await this.budgets.finishPaidCall(reservation, {
        dispatched,
        actualCost: dispatched ? Number(ledgerUsd(estimate)) : null,
        actualCurrency: "USD",
      });
      throw error;
    }
  }
  private async intent(
    spec: ShotSpec,
    channelId: string | null,
    correlationId: string,
    providerId: string,
    modelId: string,
    estimate: Money,
  ): Promise<void> {
    await this.db.providerRequest.create({
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
