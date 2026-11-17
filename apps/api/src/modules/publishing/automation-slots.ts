import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  ChannelBriefSchema,
  type PublishingPackage,
  type ChannelBrief,
} from "@reelforge/contracts";
import { type PrismaClient, type Prisma } from "@reelforge/database";
import type { Context, Run } from "../runs/runs.types.js";
import { nextPublishingSlot } from "./automation-cadence.js";
export type AutoSlot = Prisma.V9PublishSlotGetPayload<object>;

@Injectable()
export class AutomationSlots {
  public constructor(@Inject("DATABASE") private readonly db: PrismaClient) {}
  public async reserve(
    context: Context,
    run: Run,
    packaged: PublishingPackage,
    now: Date,
  ): Promise<AutoSlot> {
    const snapshot = run.inputSnapshot;
    const brief = ChannelBriefSchema.parse(
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot.brief : null,
    );
    if (
      brief.workspaceId !== context.workspaceId ||
      brief.channelId !== run.channelId ||
      brief.id !== run.channelBriefId ||
      brief.version !== run.channelBriefVersion
    )
      throw new ConflictException("Run brief binding mismatch");
    return this.db.$transaction((tx) =>
      this.reserveLocked(tx, context, run, packaged, brief.cadence, now),
    );
  }
  private async reserveLocked(
    tx: Prisma.TransactionClient,
    context: Context,
    run: Run,
    packaged: PublishingPackage,
    cadence: ChannelBrief["cadence"],
    now: Date,
  ): Promise<AutoSlot> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`v9:slots:${context.workspaceId}:${run.channelId}`}))`;
    const existing = await tx.v9PublishSlot.findFirst({
      where: { workspaceId: context.workspaceId, runId: run.id },
    });
    if (existing) return existing;
    const account = await tx.socialAccount.findFirst({
      where: {
        workspaceId: context.workspaceId,
        channelId: run.channelId,
        platform: "YOUTUBE",
        status: "CONNECTED",
        health: "HEALTHY",
      },
      orderBy: { createdAt: "asc" },
    });
    if (!account) throw new ConflictException("YOUTUBE_RECONNECT_REQUIRED");
    const [slots, posts] = await Promise.all([
      tx.v9PublishSlot.findMany({
        where: {
          workspaceId: context.workspaceId,
          channelId: run.channelId,
          scheduledAt: { gte: now },
        },
      }),
      tx.scheduledPost.findMany({
        where: {
          workspaceId: context.workspaceId,
          channelId: run.channelId,
          scheduledAt: { gte: now },
          status: { not: "CANCELED" },
        },
      }),
    ]);
    const occupied = [
      ...slots.map((s) => s.scheduledAt),
      ...posts.flatMap((p) => (p.scheduledAt ? [p.scheduledAt] : [])),
    ];
    return tx.v9PublishSlot.create({
      data: {
        id: randomUUID(),
        workspaceId: context.workspaceId,
        runId: run.id,
        channelId: run.channelId,
        socialAccountId: account.id,
        scheduledAt: nextPublishingSlot(cadence, now, occupied),
        timezone: cadence.timezone,
        package: packaged,
      },
    });
  }
}
