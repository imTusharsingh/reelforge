import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import type { Database } from "../identity/identity.types.js";
import type { ParsedProvenance } from "./scene-media.validation.js";

export type DispatchReservation = Readonly<{
  id: string;
  budgetId: string;
  periodStart: Date;
  reservedAmount: number;
  correlationId: string;
}>;

export type Provenance = ParsedProvenance;

export type LedgerRecordInput = Readonly<{
  workspaceId: string;
  correlationId: string;
  estimate: number;
  currency: string;
  latencyMs: number;
  dispatchedPrompt: string;
  responseMetadata: Prisma.InputJsonValue;
  provenance: Provenance | null;
  error?: unknown;
}>;

export type ReserveInput = Readonly<{
  workspaceId: string;
  channelId: string | null;
  budgetId: string;
  estimate: number;
  currency: string;
  correlationId: string;
  dispatchedPrompt: string;
  providerId: string;
  capabilityId: string;
}>;

export interface SceneDispatchLedger {
  reserve(input: ReserveInput): Promise<DispatchReservation>;
  release(workspaceId: string, reservation: DispatchReservation): Promise<void>;
  settle(
    workspaceId: string,
    reservation: DispatchReservation,
    actualCost: number | null,
    estimate: number,
  ): Promise<void>;
  record(writer: ProviderRequestWriter, input: LedgerRecordInput): Promise<void>;
}

export type ProviderRequestWriter = {
  providerRequest: {
    update(args: {
      where: { workspaceId_correlationId: { workspaceId: string; correlationId: string } };
      data: Prisma.ProviderRequestUpdateInput;
    }): Promise<unknown>;
  };
};

export const SCENE_DISPATCH_LEDGER = Symbol("SCENE_DISPATCH_LEDGER");

@Injectable()
export class PrismaSceneDispatchLedger implements SceneDispatchLedger {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  public async reserve(input: ReserveInput): Promise<DispatchReservation> {
    const today = utcDay(new Date());
    const reserved = await this.db.$transaction(async (tx) => {
      await tx.providerRequest.create({
        data: {
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          correlationId: input.correlationId,
          providerId: input.providerId,
          capabilityId: input.capabilityId,
          status: "FAILED",
          estimatedCost: input.estimate,
          actualCost: null,
          currency: input.currency,
          latencyMs: 0,
          dispatchedPrompt: input.dispatchedPrompt,
          responseMetadata: { dispatched: true, costKnown: false },
          errorCode: "PENDING",
          errorMessage: "Dispatch has not finalized",
        },
      });
      const rows = await tx.$queryRaw<Array<{ id: string; period_start: Date | string }>>`
        WITH budget_day AS (
          UPDATE "provider_budgets"
          SET "reserved" = CASE WHEN "period_start" < ${today} THEN 0 ELSE "reserved" END + ${input.estimate},
              "spent" = CASE WHEN "period_start" < ${today} THEN 0 ELSE "spent" END,
              "period_start" = ${today},
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${input.budgetId}::uuid
            AND "workspace_id" = ${input.workspaceId}::uuid
            AND (CASE WHEN "period_start" < ${today} THEN 0 ELSE "reserved" + "spent" END) + ${input.estimate} <= "daily_limit"
          RETURNING "period_start"
        )
        INSERT INTO "provider_budget_reservations"
          ("id", "workspace_id", "budget_id", "correlation_id", "period_start", "reserved_amount", "status", "created_at", "updated_at")
        SELECT gen_random_uuid(), ${input.workspaceId}::uuid, ${input.budgetId}::uuid, ${input.correlationId}::uuid, budget_day.period_start, ${input.estimate}, 'RESERVED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM budget_day
        RETURNING "id", "period_start"`;
      const row = rows[0];
      if (!row) throw new ConflictException("Provider daily budget exceeded");
      return row;
    });
    return {
      id: reserved.id,
      budgetId: input.budgetId,
      periodStart: asDate(reserved.period_start),
      reservedAmount: input.estimate,
      correlationId: input.correlationId,
    };
  }

  public async release(workspaceId: string, reservation: DispatchReservation): Promise<void> {
    const today = utcDay(new Date());
    await this.db.$executeRaw`
      WITH released AS (
        UPDATE "provider_budget_reservations"
        SET "status" = 'RELEASED', "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${reservation.id}::uuid AND "workspace_id" = ${workspaceId}::uuid AND "status" = 'RESERVED'
        RETURNING "reserved_amount", "period_start"
      )
      UPDATE "provider_budgets" AS budget
      SET "reserved" = GREATEST(0, budget.reserved - released.reserved_amount), "updated_at" = CURRENT_TIMESTAMP
      FROM released
      WHERE budget.id = ${reservation.budgetId}::uuid
        AND budget.workspace_id = ${workspaceId}::uuid
        AND budget.period_start = released.period_start
        AND budget.period_start >= ${today}`;
  }

  public async settle(
    workspaceId: string,
    reservation: DispatchReservation,
    actualCost: number | null,
    estimate: number,
  ): Promise<void> {
    const chargedCost = actualCost ?? estimate;
    const today = utcDay(new Date());
    await this.db.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "provider_budget_reservations"
        SET "status" = 'SETTLED', "actual_cost" = ${actualCost}, "charged_cost" = ${chargedCost}, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${reservation.id}::uuid AND "workspace_id" = ${workspaceId}::uuid AND "status" = 'RESERVED'`;
      if (updated !== 1)
        throw new ConflictException("Provider reservation could not be settled exactly once");
      const applied = await tx.$executeRaw`
        UPDATE "provider_budgets"
        SET "reserved" = GREATEST(0, "reserved" - ${reservation.reservedAmount}),
            "spent" = "spent" + ${chargedCost}, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${reservation.budgetId}::uuid AND "workspace_id" = ${workspaceId}::uuid
          AND "period_start" = ${reservation.periodStart}
          AND "period_start" >= ${today}`;
      await tx.providerBudgetReservation.update({
        where: { id: reservation.id },
        data: { budgetApplied: applied === 1 },
      });
    });
  }

  public async record(writer: ProviderRequestWriter, input: LedgerRecordInput): Promise<void> {
    const provenance = input.provenance;
    const actualCost = typeof provenance?.cost === "number" ? provenance.cost : null;
    await writer.providerRequest.update({
      where: {
        workspaceId_correlationId: {
          workspaceId: input.workspaceId,
          correlationId: input.correlationId,
        },
      },
      data: {
        status: input.error === undefined ? "SUCCEEDED" : "FAILED",
        usage: provenance?.usage ?? Prisma.JsonNull,
        estimatedCost: input.estimate,
        actualCost,
        currency: provenance?.currency ?? input.currency,
        latencyMs: input.latencyMs,
        dispatchedPrompt: input.dispatchedPrompt,
        responseMetadata: input.responseMetadata,
        errorCode: errorCode(input.error),
        errorMessage: errorMessage(input.error),
      },
    });
  }
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function asDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new ConflictException("Reservation period was not returned");
  return date;
}

function errorCode(error: unknown): string | null {
  if (error === undefined) return null;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

function errorMessage(error: unknown): string | null {
  if (error === undefined) return null;
  return error instanceof Error ? error.message : "Provider dispatch failed";
}
