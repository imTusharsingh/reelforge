import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@reelforge/database";
import { z } from "zod";
import { PROVIDER_REGISTRY, SCRIPT_LLM, type ProviderRegistry } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { PRE_DISPATCH_ERROR_CODES } from "../usage-budget/usage-budget.types.js";
import type { ScriptLlmPort } from "./script.types.js";
import {
  providerEnvelopeSchema,
  provenanceSchema,
  type Reservation,
} from "./script-generation.types.js";
@Injectable()
export class ScriptLedger {
  public constructor(
    @Inject("DATABASE") protected readonly db: Database,
    @Inject(SCRIPT_LLM) protected readonly llm: ScriptLlmPort,
    @Inject(PROVIDER_REGISTRY) protected readonly registry: ProviderRegistry,
    @Optional() now?: (() => Date) | undefined,
    // M18 budget preflight (B1). Required by Nest DI (ScriptModule imports UsageBudgetModule);
    // the parameter is optional only so hand-built unit fixtures without a budget still compile.
    @Inject(UsageBudgetService) protected readonly usage?: UsageBudgetService,
  ) {
    this.now = now ?? ((): Date => new Date());
  }
  protected readonly now: () => Date;
  protected async markNotDispatched(
    workspaceId: string,
    correlationId: string,
    error: unknown,
  ): Promise<void> {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      PRE_DISPATCH_ERROR_CODES.includes(error.code)
        ? error.code
        : "NOT_DISPATCHED";
    await this.db.providerRequest.updateMany({
      where: { workspaceId, correlationId, errorCode: "PENDING" },
      data: {
        status: "FAILED",
        errorCode: code,
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Not dispatched",
        responseMetadata: { dispatched: false, costKnown: false },
      },
    });
  }
  protected editor(context: WorkspaceContext): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }
  protected providerResponse(
    result: z.infer<typeof providerEnvelopeSchema> | undefined,
  ): Record<string, unknown> {
    const metadata = z
      .object({ modelVersion: z.unknown(), promptVersion: z.unknown(), cost: z.unknown() })
      .loose()
      .safeParse(result?.metadata);
    return {
      dispatched: true,
      providerRequestId: result?.providerRequestId ?? null,
      modelVersion:
        metadata.success && typeof metadata.data.modelVersion === "string"
          ? metadata.data.modelVersion
          : null,
      promptVersion:
        metadata.success && typeof metadata.data.promptVersion === "string"
          ? metadata.data.promptVersion
          : null,
      costKnown: metadata.success && typeof metadata.data.cost === "number",
    };
  }
  protected async recordRequest(input: {
    context: WorkspaceContext;
    channelId: string | null;
    correlationId: string;
    estimate: number;
    estimationCurrency: string;
    dispatchedPrompt: string;
    latencyMs: number;
    result?: z.infer<typeof providerEnvelopeSchema>;
    error?: unknown;
    response: Record<string, unknown>;
  }): Promise<void> {
    const provenance = provenanceSchema.safeParse(input.result?.metadata).data;
    const actualCost = typeof provenance?.cost === "number" ? provenance.cost : null;
    const data = {
      channelId: input.channelId,
      providerId: this.llm.capability.providerId,
      capabilityId: this.llm.capability.capabilityId,
      status: (input.error === undefined ? "SUCCEEDED" : "FAILED") as "SUCCEEDED" | "FAILED",
      usage: provenance?.usage ?? Prisma.JsonNull,
      estimatedCost: input.estimate,
      actualCost,
      currency: provenance?.currency ?? input.estimationCurrency,
      latencyMs: input.latencyMs,
      dispatchedPrompt: input.dispatchedPrompt,
      responseMetadata: input.response as Prisma.InputJsonValue,
      errorCode:
        input.error instanceof Error
          ? input.error.name
          : input.error === undefined
            ? null
            : "UNKNOWN",
      errorMessage:
        input.error instanceof Error
          ? input.error.message
          : input.error === undefined
            ? null
            : "Provider dispatch failed",
    };
    try {
      await this.db.providerRequest.upsert({
        where: {
          workspaceId_correlationId: {
            workspaceId: input.context.workspaceId,
            correlationId: input.correlationId,
          },
        },
        create: {
          workspaceId: input.context.workspaceId,
          correlationId: input.correlationId,
          ...data,
        },
        update: data,
      });
    } catch (ledgerError) {
      if (input.error === undefined) throw ledgerError;
    }
  }
  protected async reserveBudget(
    workspaceId: string,
    channelId: string | null,
    estimate: number,
    correlationId: string,
    dispatchedPrompt: string,
  ): Promise<Reservation> {
    const budget = await this.db.providerBudget.findFirst({
      where: { workspaceId, OR: [{ channelId: channelId ?? null }, { channelId: null }] },
      orderBy: { channelId: "asc" },
      select: { id: true },
    });
    if (!budget) throw new ConflictException("No workspace provider budget is configured");
    const today = new Date(
      Date.UTC(this.now().getUTCFullYear(), this.now().getUTCMonth(), this.now().getUTCDate()),
    );
    const reserved = await this.db.$transaction(async (tx) => {
      await this.createPendingRequest(
        tx,
        workspaceId,
        channelId,
        correlationId,
        estimate,
        dispatchedPrompt,
      );
      return tx.$queryRaw<Array<{ id: string; period_start: string }>>`
        WITH budget_day AS (
          UPDATE "provider_budgets"
          SET "reserved" = CASE WHEN "period_start" < ${today} THEN 0 ELSE "reserved" END + ${estimate},
              "spent" = CASE WHEN "period_start" < ${today} THEN 0 ELSE "spent" END,
              "period_start" = ${today},
              "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${budget.id}::uuid
            AND "workspace_id" = ${workspaceId}::uuid
            AND (CASE WHEN "period_start" < ${today} THEN 0 ELSE "reserved" + "spent" END) + ${estimate} <= "daily_limit"
          RETURNING "period_start"
        )
        INSERT INTO "provider_budget_reservations"
          ("id", "workspace_id", "budget_id", "correlation_id", "period_start", "reserved_amount", "status", "created_at", "updated_at")
        SELECT gen_random_uuid(), ${workspaceId}::uuid, ${budget.id}::uuid, ${correlationId}::uuid, budget_day.period_start, ${estimate}, 'RESERVED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM budget_day
        RETURNING "id", "period_start"`;
    });
    const row = reserved[0];
    if (!row) {
      // The PENDING row committed above; record that this call never reached the provider so the
      // M18 ledger does not charge it.
      const exceeded = new ConflictException("Provider daily budget exceeded");
      await this.markNotDispatched(workspaceId, correlationId, exceeded);
      throw exceeded;
    }
    return {
      id: row.id,
      budgetId: budget.id,
      periodStart: row.period_start,
      reservedAmount: estimate,
    };
  }
  private async createPendingRequest(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string | null,
    correlationId: string,
    estimate: number,
    dispatchedPrompt: string,
  ): Promise<void> {
    await tx.providerRequest.create({
      data: {
        workspaceId,
        channelId,
        correlationId,
        providerId: this.llm.capability.providerId,
        capabilityId: this.llm.capability.capabilityId,
        status: "FAILED",
        estimatedCost: estimate,
        actualCost: null,
        currency: this.llm.capability.costModel.currency,
        latencyMs: 0,
        dispatchedPrompt,
        responseMetadata: { dispatched: true, costKnown: false },
        errorCode: "PENDING",
        errorMessage: "Dispatch has not finalized",
      },
    });
  }
  protected async releaseBudget(workspaceId: string, reservation: Reservation): Promise<void> {
    const today = new Date(
      Date.UTC(this.now().getUTCFullYear(), this.now().getUTCMonth(), this.now().getUTCDate()),
    );
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
  protected async settleBudget(
    workspaceId: string,
    reservation: Reservation,
    actualCost: number | null,
    estimate: number,
  ): Promise<void> {
    // Preserve unknown cost separately; conservative billing uses the estimate.
    const chargedCost = actualCost ?? estimate;
    const date = this.now();
    const today = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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
          AND "period_start" = ${new Date(reservation.periodStart)}
          AND "period_start" >= ${today}`;
      await tx.providerBudgetReservation.update({
        where: { id: reservation.id },
        data: { budgetApplied: applied === 1 },
      });
    });
  }
}
