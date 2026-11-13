import { ConflictException } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { CapabilityMetadata } from "@reelforge/ai-providers";
import type { Database } from "../identity/identity.types.js";

export function paidCapability(port: unknown): CapabilityMetadata | null {
  if (typeof port !== "object" || port === null || !("capability" in port)) return null;
  const capability = (port as { capability?: unknown }).capability;
  if (typeof capability !== "object" || capability === null) return null;
  const value = capability as Partial<CapabilityMetadata>;
  return typeof value.providerId === "string" &&
    typeof value.capabilityId === "string" &&
    typeof value.costModel === "object" &&
    value.costModel !== null &&
    typeof value.costModel.currency === "string" &&
    typeof value.costModel.amount === "number" &&
    Number.isFinite(value.costModel.amount) &&
    value.costModel.amount >= 0
    ? (capability as CapabilityMetadata)
    : null;
}

export function isPaidCallReplay(error: unknown): boolean {
  if (!(error instanceof ConflictException)) return false;
  const response = error.getResponse();
  return (
    typeof response === "object" &&
    response !== null &&
    "code" in response &&
    response.code === "PAID_CALL_REPLAYED"
  );
}

export async function createPendingPaidLedger(
  db: Database,
  input: Readonly<{
    workspaceId: string;
    channelId: string | null;
    correlationId: string;
    capability: CapabilityMetadata;
    prompt: string;
  }>,
): Promise<void> {
  await db.providerRequest.create({
    data: {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      correlationId: input.correlationId,
      providerId: input.capability.providerId,
      capabilityId: input.capability.capabilityId,
      status: "FAILED",
      estimatedCost: input.capability.costModel.amount,
      actualCost: null,
      currency: input.capability.costModel.currency,
      latencyMs: 0,
      dispatchedPrompt: input.prompt,
      responseMetadata: { dispatched: false, costKnown: false },
      errorCode: "PENDING",
      errorMessage: "Dispatch has not finalized",
    },
  });
}

export async function finishPaidLedger(
  db: Database,
  input: Readonly<{
    workspaceId: string;
    correlationId: string;
    capability: CapabilityMetadata;
    dispatched: boolean;
    actualCost: number | null;
    currency?: string | null;
    metadata: Prisma.InputJsonValue;
    latencyMs: number;
    prompt: string;
    error?: unknown;
  }>,
): Promise<void> {
  await db.providerRequest.update({
    where: {
      workspaceId_correlationId: {
        workspaceId: input.workspaceId,
        correlationId: input.correlationId,
      },
    },
    data: {
      status: input.error === undefined ? "SUCCEEDED" : "FAILED",
      estimatedCost: input.capability.costModel.amount,
      actualCost: input.actualCost,
      currency: input.currency ?? input.capability.costModel.currency,
      latencyMs: input.latencyMs,
      dispatchedPrompt: input.prompt,
      responseMetadata: input.metadata,
      errorCode:
        input.error === undefined
          ? null
          : input.error instanceof Error
            ? input.error.name
            : "UNKNOWN",
      errorMessage:
        input.error === undefined
          ? null
          : input.error instanceof Error
            ? input.error.message
            : "Provider dispatch failed",
    },
  });
}
