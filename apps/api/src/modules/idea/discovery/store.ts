import { createHash, randomUUID } from "node:crypto";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  StoredChannelBriefSchema,
  LearnedChangeSchema,
  LearningStateSchema,
  RankedIdeaSchema,
  type ChannelBrief,
  type LearnedChange,
  type LearningState,
  type RankedIdea,
} from "@reelforge/contracts";
import { foundationWorkspaceGuard, type Prisma } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../../identity/identity.types.js";
import { initialLearning, normalizeTopic, topicSimilarity } from "./scoring.js";
import { learningWeek, proposeLearning } from "../../performance-intelligence/learning-policy.js";
import type { LearningSample } from "./types.js";

type Client = Database | Prisma.TransactionClient;
@Injectable()
export class DiscoveryStore {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}
  public async brief(context: WorkspaceContext, channelId: string): Promise<ChannelBrief> {
    await this.assertChannel(context, channelId);
    const brief = await foundationWorkspaceGuard(this.db, context).channelBrief.findFirst({
      where: { channelId },
      orderBy: { version: "desc" },
    });
    if (!brief) throw new NotFoundException("Channel Brief not found");
    return StoredChannelBriefSchema.parse(brief.document);
  }
  public async assertChannel(context: WorkspaceContext, channelId: string): Promise<void> {
    if (!context.workspaceId || !context.userId)
      throw new ForbiddenException("Verified workspace context required");
    if (
      !(await this.db.channel.findFirst({
        where: { id: channelId, workspaceId: context.workspaceId },
      }))
    )
      throw new NotFoundException("Channel not found");
  }
  public async claim(
    context: WorkspaceContext,
    channelId: string,
    slot: string,
    now: Date,
  ): Promise<boolean> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    const inserted = await this.db.discoveryRecord.createMany({
      data: [
        {
          id: randomUUID(),
          workspaceId: context.workspaceId,
          channelId,
          kind: "TICK",
          key: slot,
          document: { status: "CLAIMED" },
          createdAt: now,
        },
      ],
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }
  public async state(
    context: WorkspaceContext,
    brief: ChannelBrief,
    client: Client = this.db,
  ): Promise<LearningState> {
    const row = await client.discoveryRecord.findFirst({
      where: {
        workspaceId: context.workspaceId,
        channelId: brief.channelId,
        kind: "STATE",
        key: String(brief.version),
      },
    });
    return row ? LearningStateSchema.parse(row.document) : initialLearning(brief);
  }
  public history(
    context: WorkspaceContext,
    channelId: string,
  ): ReturnType<Database["idea"]["findMany"]> {
    return this.db.idea.findMany({
      where: { workspaceId: context.workspaceId, channelId },
      orderBy: { createdAt: "desc" },
    });
  }
  public async learn(
    context: WorkspaceContext,
    brief: ChannelBrief,
    samples: readonly LearningSample[],
    now: Date,
  ): Promise<LearningState> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.workspaceId + brief.channelId}, 0))`;
      const before = await this.state(context, brief, tx);
      const week = learningWeek(now);
      const existing = await tx.discoveryRecord.findFirst({
        where: {
          workspaceId: context.workspaceId,
          channelId: brief.channelId,
          kind: "LEARNING",
          key: week,
        },
      });
      if (existing) return before;
      const change = proposeLearning(brief, before, samples, now, randomUUID());
      // Insufficient evidence is retried next tick; no weekly update has been consumed.
      if (change.mode === "INSUFFICIENT_DATA") return before;
      await tx.discoveryRecord.create({
        data: {
          id: change.id,
          workspaceId: context.workspaceId,
          channelId: brief.channelId,
          kind: "LEARNING",
          key: week,
          document: change,
          createdAt: now,
        },
      });
      await tx.discoveryRecord.upsert({
        where: {
          workspaceId_channelId_kind_key: {
            workspaceId: context.workspaceId,
            channelId: brief.channelId,
            kind: "STATE",
            key: String(brief.version),
          },
        },
        create: {
          workspaceId: context.workspaceId,
          channelId: brief.channelId,
          kind: "STATE",
          key: String(brief.version),
          document: change.after,
        },
        update: { document: change.after },
      });
      return change.after;
    });
  }
  public async changes(context: WorkspaceContext, channelId: string): Promise<LearnedChange[]> {
    await this.assertChannel(context, channelId);
    const rows = await this.db.discoveryRecord.findMany({
      where: { workspaceId: context.workspaceId, channelId, kind: "LEARNING" },
      orderBy: { createdAt: "desc" },
      take: 52,
    });
    return rows.map((row) => LearnedChangeSchema.parse(row.document));
  }
  public async latestIdeas(context: WorkspaceContext, channelId: string): Promise<RankedIdea[]> {
    await this.assertChannel(context, channelId);
    const row = await this.db.discoveryRecord.findFirst({
      where: { workspaceId: context.workspaceId, channelId, kind: "RESULT" },
      orderBy: [{ createdAt: "desc" }, { key: "desc" }],
      select: { document: true },
    });
    return row ? RankedIdeaSchema.array().parse(row.document) : [];
  }
  public async finish(
    context: WorkspaceContext,
    brief: ChannelBrief,
    slot: string,
    ideas: RankedIdea[],
    now: Date,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${context.workspaceId + brief.channelId}, 0))`;
      const recent = await tx.idea.findMany({
        where: {
          workspaceId: context.workspaceId,
          channelId: brief.channelId,
          OR: [
            { createdAt: { gte: new Date(now.getTime() - 7 * 86400000) } },
            { approvedAt: { gte: new Date(now.getTime() - 7 * 86400000) } },
          ],
        },
        select: { topic: true },
      });
      const accepted = ideas.filter(
        (idea) => !recent.some((row) => topicSimilarity(row.topic, idea.topic) >= 0.55),
      );
      for (const [index, idea] of accepted.entries())
        await this.persistIdea(tx, context, brief, idea, index === 0, now);
      await tx.discoveryRecord.create({
        data: {
          workspaceId: context.workspaceId,
          channelId: brief.channelId,
          kind: "RESULT",
          key: slot,
          document: accepted,
          createdAt: now,
        },
      });
      await tx.discoveryRecord.updateMany({
        where: {
          workspaceId: context.workspaceId,
          channelId: brief.channelId,
          kind: "TICK",
          key: slot,
        },
        data: { document: { status: "SUCCEEDED", count: accepted.length } },
      });
    });
  }
  private async persistIdea(
    tx: Prisma.TransactionClient,
    context: WorkspaceContext,
    brief: ChannelBrief,
    idea: RankedIdea,
    selected: boolean,
    now: Date,
  ): Promise<void> {
    const approve = selected && brief.requestedAutonomy !== "L1";
    const content = {
      channelId: brief.channelId,
      seriesId: null,
      topic: idea.topic,
      hook: idea.hook,
      angle: idea.angle,
      audience: brief.audience,
      references: idea.sources.map((source) => source.url),
      sourceNotes: JSON.stringify({
        score: idea.score,
        factors: idea.factors,
        sources: idea.sources,
        briefId: brief.id,
        briefVersion: brief.version,
      }),
      expectedFormat: idea.formatKey,
      modelVersion: process.env.GEMINI_TEXT_MODEL ?? null,
      promptVersion: "trend-scout-v1",
      cost: null,
      costCurrency: null,
    };
    await tx.idea.create({
      data: {
        ...content,
        id: idea.id,
        workspaceId: context.workspaceId,
        createdByUserId: context.userId,
        origin: "AI",
        title: idea.topic,
        normalizedTitle: normalizeTopic(idea.topic),
        status: approve ? "APPROVED" : "DRAFT",
        approvedAt: approve ? now : null,
        createdAt: now,
      },
    });
    if (approve)
      await tx.ideaApprovalSnapshot.create({
        data: {
          ...content,
          workspaceId: context.workspaceId,
          ideaId: idea.id,
          checksumSha256: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
        },
      });
  }
  public async failure(context: WorkspaceContext, channelId: string, slot: string): Promise<void> {
    await this.db.discoveryRecord.updateMany({
      where: { workspaceId: context.workspaceId, channelId, kind: "TICK", key: slot },
      data: {
        document: {
          status: "FAILED",
          reason: "Discovery failed; inspect worker logs and ledger before retrying paid calls.",
        },
      },
    });
  }
}
