import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { IdeaProposalLlmPort } from "@reelforge/ai-providers";
import { IDEA_PROPOSAL_LLM } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { IdeaInput } from "./idea.types.js";

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
      currency?: string;
    },
  ): Promise<unknown> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
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
        select: { id: true },
      });
      if (!series) throw new NotFoundException("Series not found");
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
        channelId: input.channelId ?? null,
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
    prompt: string,
    contextText?: string,
  ): Promise<unknown> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    const result = await this.llm.proposeIdea(
      contextText === undefined ? { prompt } : { prompt, context: contextText },
    );
    return this.create(context, result.proposal, "AI", { ...result.metadata });
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
    if (next === "APPROVED" || next === "SCHEDULED")
      await this.assertDiversityAndCooldown(
        context,
        idea.channelId,
        idea.seriesId,
        idea.topic,
        idea.id,
      );
    return this.db.idea.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      data: {
        status: next,
        approvedAt: next === "APPROVED" || next === "SCHEDULED" ? new Date() : null,
        scheduledAt: next === "SCHEDULED" ? (scheduledAt ?? null) : null,
      },
    });
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
    });
    if (recent.some((idea) => normalizeTitle(idea.topic) === normalizeTitle(topic)))
      throw new ConflictException("Cooldown prevents a recent idea with the same topic");
    if (recent.length >= 3 && new Set(recent.map((idea) => normalizeTitle(idea.topic))).size === 1)
      throw new ConflictException("Minimum topic diversity rule not satisfied");
  }
}
