import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  BriefInputSchema,
  ChannelBriefSchema,
  StoredChannelBriefSchema,
  autonomyPolicy,
  type ChannelBrief,
} from "@reelforge/contracts";
import { foundationWorkspaceGuard } from "@reelforge/database";
import { BriefApprovals } from "./brief-approvals.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";

@Injectable()
export class BriefService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly approvals: BriefApprovals,
  ) {}

  public async list(context: WorkspaceContext, channelId: string): Promise<ChannelBrief[]> {
    await this.channel(context, channelId);
    const rows = await foundationWorkspaceGuard(this.db, context).channelBrief.findMany({
      where: { channelId },
      orderBy: { version: "desc" },
    });
    return rows.map((row) => StoredChannelBriefSchema.parse(row.document));
  }

  public async create(
    context: WorkspaceContext,
    channelId: string,
    body: unknown,
  ): Promise<ChannelBrief> {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
    await this.channel(context, channelId);
    const parsed = BriefInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const scoped = foundationWorkspaceGuard(this.db, context);
    const approved = await this.approvals.count(context, channelId);
    if (
      autonomyPolicy(parsed.data.requestedAutonomy, approved).effective !==
      parsed.data.requestedAutonomy
    )
      throw new BadRequestException("L3 requires 10 approved Shorts");
    const latest = await scoped.channelBrief.findFirst({
      where: { channelId },
      orderBy: { version: "desc" },
    });
    const document = ChannelBriefSchema.parse({
      ...parsed.data,
      id: randomUUID(),
      workspaceId: context.workspaceId,
      channelId,
      schemaVersion: "1.1",
      version: (latest?.version ?? 0) + 1,
    });
    // The unique workspace/channel/version index rejects concurrent stale appends.
    try {
      await scoped.channelBrief.create({
        data: {
          id: document.id,
          workspaceId: context.workspaceId,
          channelId,
          version: document.version,
          schemaVersion: document.schemaVersion,
          document,
        },
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
        throw new ConflictException("The Brief changed. Reload before saving again.");
      throw error;
    }
    return document;
  }

  public async eligibility(
    context: WorkspaceContext,
    channelId: string,
  ): Promise<{ approvedShorts: number; offerL3: boolean }> {
    await this.channel(context, channelId);
    const approvedShorts = await this.approvals.count(context, channelId);
    return { approvedShorts, offerL3: autonomyPolicy("L2", approvedShorts).offerL3 };
  }

  private async channel(context: WorkspaceContext, id: string): Promise<void> {
    const row = await this.db.channel.findFirst({
      where: { workspaceId: context.workspaceId, id },
    });
    if (!row) throw new NotFoundException("Channel not found");
  }
}
