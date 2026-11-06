import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PROVIDER_REGISTRY, SCRIPT_LLM, type ProviderRegistry } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { ScriptLlmPort } from "./script.types.js";
import { parseScriptDocument, validateScript } from "./script.validation.js";

@Injectable()
export class ScriptService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(SCRIPT_LLM) private readonly llm: ScriptLlmPort,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
  ) {}
  public async generate(
    context: WorkspaceContext,
    input: Readonly<{
      approvedIdeaSnapshotId: string;
      approvedIdeaChecksum: string;
      prompt: string;
      channelId?: string;
      configSnapshotId?: string;
      promptSnapshotId?: string;
    }>,
  ): Promise<unknown> {
    this.editor(context);
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
    )
      throw new ConflictException(
        "Approved idea snapshot is missing, foreign, stale, or not approved",
      );
    this.registry.assertReady(
      this.llm.capability,
      process.env.NODE_ENV === "production" ? "production" : "development",
    );
    const estimate = this.llm.capability.costModel.amount;
    if (estimate === null)
      throw new ConflictException("Provider cost is unknown; budget preflight cannot dispatch");
    const budget = await this.reserveBudget(context.workspaceId, input.channelId, estimate);
    const correlationId = randomUUID();
    const started = Date.now();
    let result: Awaited<ReturnType<ScriptLlmPort["complete"]>>;
    try {
      result = await this.llm.complete({
        prompt: `${input.prompt}\nApproved idea snapshot: ${snapshot.topic}\n${snapshot.hook}\n${snapshot.angle}`,
        correlationId,
      });
    } catch (error) {
      await this.releaseBudget(budget.id, estimate);
      await this.failure(context, correlationId, error);
      throw error;
    }
    const provenance = z
      .object({
        modelVersion: z.string().min(1),
        promptVersion: z.string().min(1),
        cost: z.number().finite().nonnegative().nullable(),
        currency: z.string().min(1).optional(),
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative().optional(),
            outputTokens: z.number().int().nonnegative().optional(),
            seconds: z.number().nonnegative().optional(),
            characters: z.number().int().nonnegative().optional(),
          })
          .optional(),
      })
      .safeParse(result.metadata);
    if (!provenance.success) {
      await this.failure(context, correlationId, new Error("Invalid provider provenance"));
      throw new ConflictException("Provider returned invalid provenance");
    }
    const document = parseScriptDocument(result.output);
    validateScript(document);
    const genre = await this.db.genre.findFirst({
      where: { workspaceId: context.workspaceId, name: document.metadata.genre },
      select: { id: true },
    });
    if (!genre) throw new ConflictException("Script genre is not configured for this workspace");
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
          promptVersion: result.metadata.promptVersion,
          modelVersion: result.metadata.modelVersion,
          cost: result.metadata.cost,
          costCurrency: result.metadata.currency ?? null,
          ...(input.configSnapshotId === undefined
            ? {}
            : { configSnapshotId: input.configSnapshotId }),
          ...(input.promptSnapshotId === undefined
            ? {}
            : { promptSnapshotId: input.promptSnapshotId }),
          createdByUserId: context.userId,
        },
      });
      await tx.providerRequest.create({
        data: {
          workspaceId: context.workspaceId,
          correlationId,
          providerId: this.llm.capability.providerId,
          capabilityId: this.llm.capability.capabilityId,
          status: "SUCCEEDED",
          ...(result.metadata.usage === undefined ? {} : { usage: result.metadata.usage }),
          estimatedCost: result.metadata.cost,
          actualCost: result.metadata.cost,
          currency: result.metadata.currency ?? null,
          latencyMs: Date.now() - started,
          responseMetadata: { providerRequestId: result.providerRequestId ?? null },
        },
      });
      return script;
    });
    return this.get(context, created.id);
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
    const genre = await this.db.genre.findFirst({
      where: { workspaceId: context.workspaceId, name: document.metadata.genre },
      select: { id: true },
    });
    if (!genre) throw new ConflictException("Script genre is not configured for this workspace");
    await this.validateCharacters(context, document);
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      select: { currentRevision: true, status: true },
    });
    if (!row) throw new NotFoundException("Script not found");
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
    )
      throw new ConflictException("Approved idea snapshot is stale or no longer approved");
    await this.db.script.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
    return this.exportApproved(context, id);
  }
  public async exportApproved(context: WorkspaceContext, id: string): Promise<unknown> {
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (!row || row.status !== "APPROVED")
      throw new ConflictException("Only approved scripts can be exported");
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
    )
      throw new ConflictException("Script references an unpublished or foreign character version");
  }
  private async failure(
    context: WorkspaceContext,
    correlationId: string,
    error: unknown,
  ): Promise<void> {
    await this.db.providerRequest.create({
      data: {
        workspaceId: context.workspaceId,
        correlationId,
        providerId: this.llm.capability.providerId,
        capabilityId: this.llm.capability.capabilityId,
        status: "FAILED",
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
        errorMessage: error instanceof Error ? error.message : "Provider dispatch failed",
      },
    });
  }
  private async reserveBudget(
    workspaceId: string,
    channelId: string | undefined,
    estimate: number,
  ): Promise<{ id: string }> {
    const budget = await this.db.providerBudget.findFirst({
      where: { workspaceId, channelId: channelId ?? null },
      select: { id: true },
    });
    if (!budget) throw new ConflictException("No workspace provider budget is configured");
    const updated = await this.db
      .$executeRaw`UPDATE "provider_budgets" SET "reserved" = "reserved" + ${estimate}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${budget.id}::uuid AND "workspace_id" = ${workspaceId}::uuid AND "reserved" + ${estimate} <= "daily_limit"`;
    if (updated !== 1) throw new ConflictException("Provider daily budget exceeded");
    return budget;
  }
  private async releaseBudget(id: string, amount: number): Promise<void> {
    await this.db.providerBudget.update({
      where: { id },
      data: { reserved: { decrement: amount } },
    });
  }
}
