import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { IdeaProposalLlmPort } from "@reelforge/ai-providers";
import { IDEA_PROPOSAL_LLM } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { ApprovedIdeaSnapshot, IdeaInput } from "./idea.types.js";
import { aiMetadataSchema, parseAiProposal } from "./idea.validation.js";
import { Optional, ServiceUnavailableException } from "@nestjs/common";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import {
  createPendingPaidLedger,
  finishPaidLedger,
  paidCapability,
} from "../usage-budget/paid-call.js";

const transitions: Record<string, ReadonlySet<string>> = {
  DRAFT: new Set(["BACKLOG", "APPROVED", "REJECTED"]),
  BACKLOG: new Set(["APPROVED", "REJECTED"]),
  APPROVED: new Set(["SCHEDULED", "REJECTED"]),
  SCHEDULED: new Set(["REJECTED"]),
  REJECTED: new Set(["BACKLOG"]),
};

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function similarity(left: string, right: string): number {
  const a = new Set(normalizeTitle(left).split(" ").filter(Boolean));
  const b = new Set(normalizeTitle(right).split(" ").filter(Boolean));
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

type ApprovalSnapshotData = {
  id: string;
  workspaceId: string;
  ideaId: string;
  channelId: string | null;
  seriesId: string | null;
  topic: string;
  hook: string;
  angle: string;
  audience: string;
  references: string[];
  sourceNotes: string | null;
  expectedFormat: string;
  modelVersion: string | null;
  promptVersion: string | null;
  cost: number | null;
  costCurrency: string | null;
  checksumSha256: string;
};

@Injectable()
export class IdeaService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(IDEA_PROPOSAL_LLM) private readonly llm: IdeaProposalLlmPort,
    @Optional() @Inject(UsageBudgetService) private readonly usage?: UsageBudgetService,
  ) {}

  public async create(
    context: WorkspaceContext,
    input: IdeaInput,
    origin: "USER" | "AI",
    metadata?: {
      modelVersion: string;
      promptVersion: string;
      cost: number | null;
      currency?: string | undefined;
    },
  ): Promise<unknown> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    let canonicalChannelId = input.channelId;
    const normalizedTitle = normalizeTitle(input.title);
    const existing = await this.db.idea.findMany({
      where: { workspaceId: context.workspaceId },
      select: { id: true, title: true, normalizedTitle: true, topic: true },
    });
    const duplicateMatches = existing.flatMap((candidate) => {
      const score = similarity(input.title, candidate.title);
      const exact = candidate.normalizedTitle === normalizedTitle;
      if (!exact && score < 0.55) return [];
      return [
        {
          matchedIdeaId: candidate.id,
          reason: exact ? "exact normalized title" : "similar title",
          score,
        },
      ];
    });
    if (input.channelId !== undefined) {
      const channel = await this.db.channel.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.channelId } },
        select: { id: true },
      });
      if (!channel) throw new NotFoundException("Channel not found");
    }
    if (input.seriesId !== undefined) {
      const series = await this.db.contentSeries.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.seriesId } },
        select: { id: true, channelId: true },
      });
      if (!series) throw new NotFoundException("Series not found");
      if (canonicalChannelId !== undefined && canonicalChannelId !== series.channelId)
        throw new BadRequestException("channelId must match the series channel");
      canonicalChannelId = series.channelId;
    }
    return this.db.idea.create({
      data: {
        workspaceId: context.workspaceId,
        createdByUserId: context.userId,
        origin,
        title: input.title,
        normalizedTitle,
        topic: input.topic,
        hook: input.hook,
        angle: input.angle,
        audience: input.audience,
        references: input.references,
        sourceNotes: input.sourceNotes ?? null,
        expectedFormat: input.expectedFormat,
        channelId: canonicalChannelId ?? null,
        seriesId: input.seriesId ?? null,
        modelVersion: metadata?.modelVersion ?? null,
        promptVersion: metadata?.promptVersion ?? null,
        cost: metadata?.cost ?? null,
        costCurrency: metadata?.currency ?? null,
        duplicateMatches: {
          create: duplicateMatches.map((match) => ({
            workspaceId: context.workspaceId,
            matchedIdeaId: match.matchedIdeaId,
            reason: match.reason,
            score: match.score,
          })),
        },
      },
      include: { duplicateMatches: true },
    });
  }

  public async propose(
    context: WorkspaceContext,
    request: {
      prompt: string;
      contextText?: string | undefined;
      channelId?: string | undefined;
      seriesId?: string | undefined;
      correlationId?: string | undefined;
    },
  ): Promise<unknown> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    const capability = paidCapability(this.llm);
    const correlationId = request.correlationId ?? randomUUID();
    const estimate = capability?.costModel.amount;
    if (
      capability === null ||
      estimate === null ||
      estimate === undefined ||
      this.usage === undefined
    )
      throw new ServiceUnavailableException(
        "Idea proposal LLM is not configured for paid dispatch",
      );
    const reservation = await this.usage.reservePaidCall({
      workspaceId: context.workspaceId,
      channelId: request.channelId ?? null,
      correlationId,
      category: "LLM",
      currency: capability.costModel.currency,
      estimate,
    });
    if (reservation === null)
      throw new ServiceUnavailableException("Budget policy is unavailable; idea proposal refused");
    const prompt = request.prompt;
    let dispatched = false;
    let ledgerCreated = false;
    const started = Date.now();
    try {
      await createPendingPaidLedger(this.db, {
        workspaceId: context.workspaceId,
        channelId: request.channelId ?? null,
        correlationId,
        capability,
        prompt,
      });
      ledgerCreated = true;
      dispatched = true;
      const result = await this.llm.proposeIdea(
        request.contextText === undefined
          ? { prompt: request.prompt, correlationId }
          : { prompt: request.prompt, context: request.contextText, correlationId },
      );
      let proposal: IdeaInput;
      try {
        proposal = parseAiProposal(result.proposal, {
          ...(request.channelId === undefined ? {} : { channelId: request.channelId }),
          ...(request.seriesId === undefined ? {} : { seriesId: request.seriesId }),
        });
      } catch {
        throw new BadRequestException("AI provider returned an invalid proposal");
      }
      const metadataResult = aiMetadataSchema.safeParse(result.metadata);
      if (!metadataResult.success)
        throw new BadRequestException("AI provider returned invalid provenance metadata");
      const metadata = metadataResult.data;
      const created = await this.create(context, proposal, "AI", metadata);
      await finishPaidLedger(this.db, {
        workspaceId: context.workspaceId,
        correlationId,
        capability,
        dispatched,
        actualCost: metadata.cost,
        currency: metadata.currency ?? null,
        metadata: { dispatched: true, costKnown: metadata.cost !== null },
        latencyMs: Date.now() - started,
        prompt,
      });
      await this.usage.finishPaidCall(reservation, {
        dispatched,
        actualCost: metadata.cost,
        actualCurrency: metadata.currency ?? null,
      });
      return created;
    } catch (error) {
      if (ledgerCreated)
        await finishPaidLedger(this.db, {
          workspaceId: context.workspaceId,
          correlationId,
          capability,
          dispatched,
          actualCost: null,
          metadata: { dispatched, costKnown: false },
          latencyMs: Date.now() - started,
          prompt,
          error,
        });
      await this.usage.finishPaidCall(reservation, { dispatched, actualCost: null });
      throw error;
    }
  }

  public async list(
    context: WorkspaceContext,
    status?: string,
    includeArchived = false,
  ): Promise<unknown> {
    return this.db.idea.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(status === undefined ? {} : { status: status as never }),
      },
      include: { duplicateMatches: true },
      orderBy: { createdAt: "desc" },
    });
  }

  private writable(context: WorkspaceContext): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }

  /** The approved snapshot is immutable; editing is only available before approval. */
  public async edit(
    context: WorkspaceContext,
    id: string,
    input: IdeaInput,
    expectedUpdatedAt: Date,
  ): Promise<unknown> {
    this.writable(context);
    const idea = await this.db.idea.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
    });
    if (!idea) throw new NotFoundException("Idea not found");
    const approvedSnapshot = await this.db.ideaApprovalSnapshot.findUnique({
      where: { workspaceId_ideaId: { workspaceId: context.workspaceId, ideaId: id } },
      select: { id: true },
    });
    if (
      approvedSnapshot ||
      idea.archivedAt ||
      !["DRAFT", "BACKLOG", "REJECTED"].includes(idea.status)
    )
      throw new ConflictException("Approved, scheduled or archived ideas cannot be edited");

    let channelId = input.channelId;
    if (input.channelId !== undefined) {
      const channel = await this.db.channel.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.channelId } },
        select: { id: true },
      });
      if (!channel) throw new NotFoundException("Channel not found");
    }
    if (input.seriesId !== undefined) {
      const series = await this.db.contentSeries.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.seriesId } },
        select: { id: true, channelId: true },
      });
      if (!series) throw new NotFoundException("Series not found");
      if (channelId !== undefined && channelId !== series.channelId)
        throw new BadRequestException("channelId must match the series channel");
      channelId = series.channelId;
    }
    if (!channelId) throw new BadRequestException("channelId or seriesId is required");
    const changed = await this.db.idea.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id,
        updatedAt: expectedUpdatedAt,
        archivedAt: null,
        status: { in: ["DRAFT", "BACKLOG", "REJECTED"] },
      },
      data: {
        title: input.title,
        normalizedTitle: normalizeTitle(input.title),
        topic: input.topic,
        hook: input.hook,
        angle: input.angle,
        audience: input.audience,
        references: input.references,
        sourceNotes: input.sourceNotes ?? null,
        expectedFormat: input.expectedFormat,
        channelId,
        seriesId: input.seriesId ?? null,
      },
    });
    if (changed.count !== 1) throw new ConflictException("Idea changed; refresh before editing");
    return this.db.idea.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { duplicateMatches: true },
    });
  }

  private async setArchive(
    context: WorkspaceContext,
    id: string,
    expectedUpdatedAt: Date,
    restore: boolean,
  ): Promise<unknown> {
    this.writable(context);
    const idea = await this.db.idea.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
    });
    if (!idea) throw new NotFoundException("Idea not found");
    const approvedSnapshot = await this.db.ideaApprovalSnapshot.findUnique({
      where: { workspaceId_ideaId: { workspaceId: context.workspaceId, ideaId: id } },
      select: { id: true },
    });
    if (approvedSnapshot || !["DRAFT", "BACKLOG", "REJECTED"].includes(idea.status))
      throw new ConflictException("Previously approved or scheduled ideas cannot be archived");
    if (restore ? !idea.archivedAt : Boolean(idea.archivedAt))
      throw new ConflictException(restore ? "Idea is not archived" : "Idea is already archived");
    const changed = await this.db.idea.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id,
        updatedAt: expectedUpdatedAt,
        status: { in: ["DRAFT", "BACKLOG", "REJECTED"] },
        archivedAt: restore ? { not: null } : null,
      },
      data: { archivedAt: restore ? null : new Date() },
    });
    if (changed.count !== 1) throw new ConflictException("Idea changed; refresh before retrying");
    return this.db.idea.findUniqueOrThrow({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { duplicateMatches: true },
    });
  }
  public archive(context: WorkspaceContext, id: string, expectedUpdatedAt: Date): Promise<unknown> {
    return this.setArchive(context, id, expectedUpdatedAt, false);
  }
  public restore(context: WorkspaceContext, id: string, expectedUpdatedAt: Date): Promise<unknown> {
    return this.setArchive(context, id, expectedUpdatedAt, true);
  }

  public async transition(
    context: WorkspaceContext,
    id: string,
    next: "BACKLOG" | "APPROVED" | "REJECTED" | "SCHEDULED",
    expectedUpdatedAt: Date,
    expectedStatus: "DRAFT" | "BACKLOG" | "APPROVED" | "REJECTED" | "SCHEDULED",
    scheduledAt?: Date,
  ): Promise<unknown> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    const idea = await this.db.idea.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
    });
    if (!idea) throw new NotFoundException("Idea not found");
    if (idea.updatedAt.getTime() !== expectedUpdatedAt.getTime() || idea.status !== expectedStatus)
      throw new ConflictException("Idea changed; refresh before transitioning");
    if (idea.archivedAt)
      throw new ConflictException("Restore an archived idea before transitioning");
    if (!transitions[idea.status]?.has(next))
      throw new ConflictException(`Cannot transition ${idea.status} to ${next}`);
    if (next === "SCHEDULED" && scheduledAt === undefined)
      throw new ConflictException("scheduledAt is required");
    if (scheduledAt !== undefined && scheduledAt.getTime() <= Date.now())
      throw new ConflictException("scheduledAt must be in the future");
    if (next === "APPROVED" || next === "SCHEDULED")
      await this.assertDiversityAndCooldown(
        context,
        idea.channelId,
        idea.seriesId,
        idea.topic,
        idea.id,
      );
    const updated = {
      status: next,
      approvedAt: next === "APPROVED" || next === "SCHEDULED" ? new Date() : null,
      scheduledAt: next === "SCHEDULED" ? (scheduledAt ?? null) : null,
    };
    return this.db.$transaction(async (tx) => {
      const changed = await tx.idea.updateMany({
        where: {
          workspaceId: context.workspaceId,
          id,
          updatedAt: expectedUpdatedAt,
          status: expectedStatus,
          archivedAt: null,
        },
        data: updated,
      });
      if (changed.count !== 1)
        throw new ConflictException("Idea changed; refresh before transitioning");
      if (next !== "APPROVED" && next !== "SCHEDULED")
        return tx.idea.findUniqueOrThrow({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        });
      let snapshot: { id: string; checksumSha256: string } | null;
      if (next === "APPROVED") {
        const data = this.snapshotData({ ...idea, ...updated });
        await tx.ideaApprovalSnapshot.create({ data: { ...data, references: data.references } });
        snapshot = data;
      } else {
        snapshot = await tx.ideaApprovalSnapshot.findUnique({
          where: { workspaceId_ideaId: { workspaceId: context.workspaceId, ideaId: id } },
        });
      }
      if (!snapshot) throw new ConflictException("Approved idea snapshot is missing");
      return {
        ...idea,
        ...updated,
        approvalSnapshot: { id: snapshot.id, checksumSha256: snapshot.checksumSha256 },
      };
    });
  }

  public async getApproved(context: WorkspaceContext, id: string): Promise<ApprovedIdeaSnapshot> {
    const snapshot = await this.db.ideaApprovalSnapshot.findUnique({
      where: { workspaceId_ideaId: { workspaceId: context.workspaceId, ideaId: id } },
    });
    if (!snapshot) throw new NotFoundException("Approved idea snapshot not found");
    return {
      id: snapshot.id,
      ideaId: snapshot.ideaId,
      workspaceId: snapshot.workspaceId,
      channelId: snapshot.channelId,
      seriesId: snapshot.seriesId,
      topic: snapshot.topic,
      hook: snapshot.hook,
      angle: snapshot.angle,
      audience: snapshot.audience,
      references: Array.isArray(snapshot.references)
        ? snapshot.references.filter((value): value is string => typeof value === "string")
        : [],
      sourceNotes: snapshot.sourceNotes,
      expectedFormat: snapshot.expectedFormat,
      modelVersion: snapshot.modelVersion,
      promptVersion: snapshot.promptVersion,
      cost: snapshot.cost?.toString() ?? null,
      costCurrency: snapshot.costCurrency,
      checksumSha256: snapshot.checksumSha256,
    };
  }

  private snapshotData(idea: {
    id: string;
    workspaceId: string;
    channelId: string | null;
    seriesId: string | null;
    topic: string;
    hook: string;
    angle: string;
    audience: string;
    references: unknown;
    sourceNotes: string | null;
    expectedFormat: string;
    modelVersion: string | null;
    promptVersion: string | null;
    cost: unknown;
    costCurrency: string | null;
  }): ApprovalSnapshotData {
    const content = {
      topic: idea.topic,
      hook: idea.hook,
      angle: idea.angle,
      audience: idea.audience,
      references: idea.references as string[],
      sourceNotes: idea.sourceNotes,
      expectedFormat: idea.expectedFormat,
      channelId: idea.channelId,
      seriesId: idea.seriesId,
      modelVersion: idea.modelVersion,
      promptVersion: idea.promptVersion,
      cost: idea.cost as number | null,
      costCurrency: idea.costCurrency,
    };
    const checksumSha256 = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    return {
      id: randomUUID(),
      workspaceId: idea.workspaceId,
      ideaId: idea.id,
      ...content,
      checksumSha256,
    };
  }

  private async assertDiversityAndCooldown(
    context: WorkspaceContext,
    channelId: string | null,
    seriesId: string | null,
    topic: string,
    excludeId: string,
  ): Promise<void> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await this.db.idea.findMany({
      where: {
        workspaceId: context.workspaceId,
        id: { not: excludeId },
        status: { in: ["APPROVED", "SCHEDULED"] },
        channelId,
        seriesId,
        approvedAt: { gte: since },
      },
      select: { topic: true },
      orderBy: { approvedAt: "desc" },
      take: 3,
    });
    if (recent.some((idea) => normalizeTitle(idea.topic) === normalizeTitle(topic)))
      throw new ConflictException("Cooldown prevents a recent idea with the same topic");
    const diversityWindow = recent.map((idea) => normalizeTitle(idea.topic));
    if (diversityWindow.length === 3 && new Set(diversityWindow).size < 2)
      throw new ConflictException("Minimum topic diversity rule not satisfied");
  }
}
