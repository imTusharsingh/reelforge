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
    },
  ): Promise<unknown> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    const result = await this.llm.proposeIdea(
      request.contextText === undefined
        ? { prompt: request.prompt }
        : { prompt: request.prompt, context: request.contextText },
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
    return this.create(context, proposal, "AI", metadata);
  }

  public async list(context: WorkspaceContext, status?: string): Promise<unknown> {
    return this.db.idea.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(status === undefined ? {} : { status: status as never }),
      },
      include: { duplicateMatches: true },
      orderBy: { createdAt: "desc" },
    });
  }

  public async transition(
    context: WorkspaceContext,
    id: string,
    next: "BACKLOG" | "APPROVED" | "REJECTED" | "SCHEDULED",
    scheduledAt?: Date,
  ): Promise<unknown> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    const idea = await this.db.idea.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
    });
    if (!idea) throw new NotFoundException("Idea not found");
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
    if (next !== "APPROVED" && next !== "SCHEDULED")
      return this.db.idea.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        data: updated,
      });
    return this.db.$transaction(async (tx) => {
      const changed = await tx.idea.updateMany({
        where: { workspaceId: context.workspaceId, id, status: idea.status },
        data: updated,
      });
      if (changed.count !== 1) throw new ConflictException("Idea changed; retry the transition");
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
