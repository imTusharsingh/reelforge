import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@reelforge/database";
import { z } from "zod";
import { PROVIDER_REGISTRY, SCRIPT_LLM, type ProviderRegistry } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import {
  PRE_DISPATCH_ERROR_CODES,
  type PaidCallReservation,
} from "../usage-budget/usage-budget.types.js";
import type { ScriptLlmPort } from "./script.types.js";
import { parseScriptDocument, validateGenrePolicy, validateScript } from "./script.validation.js";

const generateSchema = z.object({
  approvedIdeaSnapshotId: z.uuid(),
  approvedIdeaChecksum: z.string().min(1),
  prompt: z.string().min(1).max(20_000),
  channelId: z.uuid().optional(),
  correlationId: z.uuid().optional(),
  configSnapshotId: z.uuid(),
  promptSnapshotId: z.uuid(),
});
const providerEnvelopeSchema = z.looseObject({
  output: z.unknown(),
  metadata: z.unknown().optional(),
  providerRequestId: z.unknown().optional(),
});
const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  seconds: z.number().nonnegative().optional(),
  characters: z.number().int().nonnegative().optional(),
});
const provenanceSchema = z.object({
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  cost: z.number().finite().nonnegative().nullable(),
  currency: z.string().min(1).optional(),
  usage: providerUsageSchema.optional(),
});
const promptBundleSchema = z.object({
  renderedText: z.string().min(1),
  fingerprintSha256: z.string().length(64),
});

type Reservation = { id: string; budgetId: string; periodStart: string; reservedAmount: number };

@Injectable()
export class ScriptService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(SCRIPT_LLM) private readonly llm: ScriptLlmPort,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Optional() now?: (() => Date) | undefined,
    // M18 budget preflight (B1). Required by Nest DI (ScriptModule imports UsageBudgetModule);
    // the parameter is optional only so hand-built unit fixtures without a budget still compile.
    @Inject(UsageBudgetService) private readonly usage?: UsageBudgetService,
  ) {
    this.now = now ?? ((): Date => new Date());
  }

  private readonly now: () => Date;

  public async generate(context: WorkspaceContext, body: unknown): Promise<unknown> {
    this.editor(context);
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const snapshot = await this.db.ideaApprovalSnapshot.findUnique({
      where: {
        workspaceId_id: { workspaceId: context.workspaceId, id: input.approvedIdeaSnapshotId },
      },
      include: { idea: { select: { status: true } } },
    });
    if (
      !snapshot ||
      snapshot.idea.status !== "APPROVED" ||
      snapshot.checksumSha256 !== input.approvedIdeaChecksum ||
      (input.channelId !== undefined && snapshot.channelId !== input.channelId)
    ) {
      throw new ConflictException(
        "Approved idea snapshot is missing, foreign, stale, or not approved",
      );
    }
    const [config, prompt] = await Promise.all([
      this.db.configSnapshot.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.configSnapshotId } },
        select: { id: true, config: true },
      }),
      this.db.promptBundleSnapshot.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.promptSnapshotId } },
        select: { id: true, configSnapshotId: true, bundle: true, fingerprintSha256: true },
      }),
    ]);
    const bundle = promptBundleSchema.safeParse(prompt?.bundle);
    if (!config || !prompt || prompt.configSnapshotId !== config.id || !bundle.success) {
      throw new ConflictException(
        "Configuration and prompt snapshots must be an owned, valid pair",
      );
    }
    if (bundle.data.fingerprintSha256 !== prompt.fingerprintSha256) {
      throw new ConflictException("Prompt snapshot fingerprint does not match its content");
    }
    this.registry.assertReady(
      this.llm.capability,
      process.env.NODE_ENV === "production" ? "production" : "development",
    );
    const estimate = this.llm.capability.costModel.amount;
    if (estimate === null) {
      throw new ConflictException("Provider cost is unknown; budget preflight cannot dispatch");
    }
    const estimationCurrency = this.llm.capability.costModel.currency;
    const correlationId = input.correlationId ?? randomUUID();

    const started = Date.now();
    const dispatchedPrompt = [
      bundle.data.renderedText,
      `Configuration: ${JSON.stringify(config.config)}`,
      `Additional instructions: ${input.prompt}`,
      `Approved idea snapshot: ${snapshot.topic}`,
      snapshot.hook,
      snapshot.angle,
    ].join("\n");
    // M18 preflight (B1), before the M08 ledger row exists so the call is not counted twice: a hard
    // stop (BUDGET_EXHAUSTED / unresolvable, 409) throws here and the provider is never called.
    // NOT_CONFIGURED (null) proceeds under the M16 manual-run rule.
    const usageHold: PaidCallReservation | null =
      this.usage === undefined
        ? null
        : await this.usage.reservePaidCall({
            workspaceId: context.workspaceId,
            channelId: input.channelId ?? null,
            correlationId,
            category: "LLM",
            currency: estimationCurrency,
            estimate,
          });
    let reservation: Reservation;
    try {
      reservation = await this.reserveBudget(
        context.workspaceId,
        input.channelId ?? null,
        estimate,
        correlationId,
        dispatchedPrompt,
      );
    } catch (error) {
      // The M08 guard refused: the provider was never called, so the M18 hold is released.
      await this.usage?.finishPaidCall(usageHold, { dispatched: false, actualCost: null });
      throw error;
    }
    let result: z.infer<typeof providerEnvelopeSchema> | undefined;
    let settled = false;
    let dispatched = false;
    let usageFinished = false;
    try {
      dispatched = true;
      const envelope = providerEnvelopeSchema.safeParse(
        await this.llm.complete({ prompt: dispatchedPrompt, correlationId }),
      );
      if (!envelope.success) throw new ConflictException("Provider returned an invalid envelope");
      result = envelope.data;
      const provenance = provenanceSchema.safeParse(result.metadata);
      await this.settleBudget(
        context.workspaceId,
        reservation,
        provenance.success ? provenance.data.cost : null,
        estimate,
      );
      settled = true;
      usageFinished = true;
      await this.usage?.finishPaidCall(usageHold, {
        dispatched: true,
        actualCost: provenance.success ? provenance.data.cost : null,
        actualCurrency: provenance.success ? (provenance.data.currency ?? null) : null,
      });
      if (!provenance.success) throw new ConflictException("Provider returned invalid provenance");
      const document = parseScriptDocument(result.output);
      validateScript(document);
      const genre = await this.db.genre.findFirst({
        where: { workspaceId: context.workspaceId, name: document.metadata.genre },
        select: { id: true, safetyProfile: true },
      });
      if (!genre) throw new ConflictException("Script genre is not configured for this workspace");
      validateGenrePolicy(document, genre, snapshot.references);
      await this.validateCharacters(context, document);
      const created = await this.db.$transaction(async (tx) => {
        const script = await tx.script.create({
          data: {
            workspaceId: context.workspaceId,
            approvedIdeaSnapshotId: snapshot.id,
            ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
            approvedIdeaChecksum: snapshot.checksumSha256,
            createdByUserId: context.userId,
          },
        });
        await tx.scriptRevision.create({
          data: {
            workspaceId: context.workspaceId,
            scriptId: script.id,
            revision: 1,
            document,
            promptVersion: provenance.data.promptVersion,
            modelVersion: provenance.data.modelVersion,
            cost: provenance.data.cost,
            costCurrency: provenance.data.currency ?? null,
            configSnapshotId: config.id,
            promptSnapshotId: prompt.id,
            promptText: dispatchedPrompt,
            createdByUserId: context.userId,
          },
        });
        return script;
      });
      await this.recordRequest({
        context,
        channelId: input.channelId ?? null,
        correlationId,
        estimate,
        estimationCurrency,
        dispatchedPrompt,
        latencyMs: Date.now() - started,
        result,
        response: this.providerResponse(result),
      });
      return this.get(context, created.id);
    } catch (error) {
      await this.recordRequest({
        context,
        channelId: input.channelId ?? null,
        correlationId,
        estimate,
        estimationCurrency,
        dispatchedPrompt,
        latencyMs: Date.now() - started,
        ...(result === undefined ? {} : { result }),
        response: this.providerResponse(result),
        error,
      });
      throw error;
    } finally {
      if (!settled) {
        await this.releaseBudget(context.workspaceId, reservation);
      }
      // A dispatched call that failed is charged at its estimate (the provider may have billed it);
      // only a call that never reached the provider is released.
      if (!usageFinished)
        await this.usage?.finishPaidCall(usageHold, { dispatched, actualCost: null });
    }
  }

  /** Marks the PENDING ledger row of a call that never reached the provider (never charged). */
  private async markNotDispatched(
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


  /** Bounded, workspace-scoped discovery, with the latest revision only. */
  public async list(context: WorkspaceContext, page = 1): Promise<unknown> {
    const rows = await this.db.script.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * 50,
      take: 51,
      include: { revisions: { orderBy: { revision: "desc" }, take: 1,
        select: { revision: true, document: true, createdAt: true } } },
    });
    return { items: rows.slice(0, 50), nextPage: rows.length > 50 ? page + 1 : null };
  }

  /** A script's persisted revisions are immutable; this exposes real history, not inferred versions. */
  public async revisions(context: WorkspaceContext, id: string, page = 1): Promise<unknown> {
    const script = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      select: { id: true },
    });
    if (!script) throw new NotFoundException("Script not found");
    const rows = await this.db.scriptRevision.findMany({
      where: { workspaceId: context.workspaceId, scriptId: id },
      orderBy: { revision: "desc" },
      skip: (page - 1) * 50,
      take: 51,
      select: { id: true, revision: true, document: true, createdAt: true,
        modelVersion: true, promptVersion: true },
    });
    return { items: rows.slice(0, 50), nextPage: rows.length > 50 ? page + 1 : null };
  }

  public async get(context: WorkspaceContext, id: string): Promise<unknown> {
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: {
        revisions: { orderBy: { revision: "desc" }, take: 1 },
        snapshot: { include: { idea: { select: { status: true } } } },
      },
    });
    if (!row) throw new NotFoundException("Script not found");
    return row;
  }

  public async revise(context: WorkspaceContext, id: string, body: unknown): Promise<unknown> {
    this.editor(context);
    const document = parseScriptDocument(body);
    validateScript(document);
    const [genre, row] = await Promise.all([
      this.db.genre.findFirst({
        where: { workspaceId: context.workspaceId, name: document.metadata.genre },
        select: { id: true, safetyProfile: true },
      }),
      this.db.script.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        select: { currentRevision: true, status: true, snapshot: { select: { references: true } } },
      }),
    ]);
    if (!genre) throw new ConflictException("Script genre is not configured for this workspace");
    if (!row) throw new NotFoundException("Script not found");
    validateGenrePolicy(document, genre, row.snapshot.references);
    await this.validateCharacters(context, document);
    if (row.status === "APPROVED") throw new ConflictException("Approved scripts are immutable");
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.script.updateMany({
        where: {
          workspaceId: context.workspaceId,
          id,
          currentRevision: row.currentRevision,
          status: { not: "APPROVED" },
        },
        data: { currentRevision: { increment: 1 }, status: "REVISION_PENDING" },
      });
      if (claimed.count !== 1)
        throw new ConflictException("Script revision changed concurrently; retry");
      await tx.scriptRevision.create({
        data: {
          workspaceId: context.workspaceId,
          scriptId: id,
          revision: row.currentRevision + 1,
          document,
          createdByUserId: context.userId,
        },
      });
    });
    return this.get(context, id);
  }

  public async approve(context: WorkspaceContext, id: string): Promise<unknown> {
    this.editor(context);
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: {
        revisions: { orderBy: { revision: "desc" }, take: 1 },
        snapshot: { include: { idea: { select: { status: true } } } },
      },
    });
    if (!row) throw new NotFoundException("Script not found");
    if (
      !row.revisions[0] ||
      row.snapshot.checksumSha256 !== row.approvedIdeaChecksum ||
      row.snapshot.idea.status !== "APPROVED"
    ) {
      throw new ConflictException("Approved idea snapshot is stale or no longer approved");
    }
    // The conditional claim binds approval to exactly the revision validated above.
    const claimed = await this.db.script.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id,
        currentRevision: row.currentRevision,
        status: { not: "APPROVED" },
      },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new ConflictException("Script changed concurrently; retry approval");
    const exported = await this.exportApproved(context, id);
    if (
      !exported ||
      typeof exported !== "object" ||
      (exported as { revision?: number }).revision !== row.currentRevision
    ) {
      throw new ConflictException("Script changed concurrently; retry approval");
    }
    return exported;
  }

  public async exportApproved(context: WorkspaceContext, id: string): Promise<unknown> {
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (!row || row.status !== "APPROVED") {
      throw new ConflictException("Only approved scripts can be exported");
    }
    return {
      scriptId: row.id,
      revision: row.currentRevision,
      approvedIdeaSnapshotId: row.approvedIdeaSnapshotId,
      document: row.revisions[0]?.document,
    };
  }

  public async providerHealth(
    context: WorkspaceContext,
    providerId: string,
    capabilityId: string,
  ): Promise<unknown> {
    this.editor(context);
    return this.registry.healthCheck(providerId, capabilityId);
  }

  private editor(context: WorkspaceContext): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }

  private async validateCharacters(
    context: WorkspaceContext,
    document: ReturnType<typeof parseScriptDocument>,
  ): Promise<void> {
    const refs = document.scenes.flatMap((scene) => scene.characterRefs);
    if (refs.length === 0) return;
    const versions = await this.db.characterVersion.findMany({
      where: {
        workspaceId: context.workspaceId,
        id: { in: refs.map((ref) => ref.versionId) },
        status: "PUBLISHED",
      },
      select: { id: true, characterId: true },
    });
    if (
      versions.length !== refs.length ||
      refs.some(
        (ref) =>
          !versions.some(
            (version) => version.id === ref.versionId && version.characterId === ref.characterId,
          ),
      )
    ) {
      throw new ConflictException("Script references an unpublished or foreign character version");
    }
  }

  private providerResponse(
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

  private async recordRequest(input: {
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

  private async reserveBudget(
    workspaceId: string,
    channelId: string | null,
    estimate: number,
    correlationId: string,
    dispatchedPrompt: string,
  ): Promise<Reservation> {
    const budget = await this.db.providerBudget.findFirst({
      where: { workspaceId, channelId: channelId ?? null },
      select: { id: true },
    });
    if (!budget) throw new ConflictException("No workspace provider budget is configured");
    const today = new Date(
      Date.UTC(this.now().getUTCFullYear(), this.now().getUTCMonth(), this.now().getUTCDate()),
    );
    const reserved = await this.db.$transaction(async (tx) => {
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

  private async releaseBudget(workspaceId: string, reservation: Reservation): Promise<void> {
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

  private async settleBudget(
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
