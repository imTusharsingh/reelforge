import { createHash, randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { pipelineV2Enabled } from "@reelforge/config-engine";
import { foundationWorkspaceGuard, type PrismaClient, type Prisma } from "@reelforge/database";
import type {
  PublishingPolicyContext,
  BudgetReservation,
  BudgetCheck,
} from "./publishing.ports.js";
import { pacificQuotaDay } from "./automation-cadence.js";

@Injectable()
export class AutomationPolicy {
  public constructor(@Inject("DATABASE") private readonly db: PrismaClient) {}
  private async slot(
    context: PublishingPolicyContext,
    db: Prisma.TransactionClient | PrismaClient = this.db,
  ): Promise<Prisma.V9PublishSlotGetPayload<object> | null> {
    const destination = await db.publishingDestination.findFirst({
      where: { workspaceId: context.workspaceId, id: context.destinationId },
    });
    return destination
      ? db.v9PublishSlot.findFirst({
          where: { workspaceId: context.workspaceId, scheduledPostId: destination.scheduledPostId },
        })
      : null;
  }
  public async check(context: PublishingPolicyContext): Promise<BudgetCheck> {
    if (!pipelineV2Enabled())
      return {
        allowed: false,
        reason: "Publishing policy is not configured for the legacy pipeline",
      };
    const slot = await this.slot(context);
    if (!slot) return { allowed: false, reason: "No approved VideoRun publishing slot" };
    const db = foundationWorkspaceGuard(this.db, {
      workspaceId: context.workspaceId,
      userId: "v9-policy",
      role: "VIEWER",
    });
    const [run, envelope, approval] = await Promise.all([
      db.videoRun.findFirst({ where: { id: slot.runId, channelId: context.channelId } }),
      db.budgetEnvelope.findFirst({ where: { runId: slot.runId } }),
      db.runEvent.findFirst({
        where: { runId: slot.runId, type: { in: ["approved", "auto_approved"] } },
      }),
    ]);
    const auto = approval?.type === "auto_approved";
    const allowed =
      !!run &&
      run.state === "SCHEDULED" &&
      run.pauseReason === null &&
      !!approval &&
      (!auto || (run.effectiveAutonomy === "L3" && run.approvedShortsAtStart >= 10)) &&
      !!envelope &&
      envelope.spentMinor + envelope.reservedMinor <= envelope.hardCapMinor;
    return {
      allowed,
      reason: allowed
        ? "V8 approval, autonomy and run budget verified"
        : "Approval, autonomy or run budget gate failed",
    };
  }
  public async reserve(context: PublishingPolicyContext): Promise<BudgetReservation> {
    if (!(await this.check(context)).allowed) throw new ConflictException("Publish policy blocked");
    const quotaDay = pacificQuotaDay(new Date());
    const projectKey = createHash("sha256")
      .update(process.env.YOUTUBE_OAUTH_CLIENT_ID ?? "unconfigured")
      .digest("hex");
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`v9:quota:${projectKey}:${quotaDay}`}))`;
      const slot = await this.slot(context, tx);
      if (!slot) throw new ConflictException("Publishing slot disappeared");
      const existing = await tx.v9InsertLease.findFirst({
        where: { workspaceId: context.workspaceId, slotId: slot.id },
      });
      if (existing && (existing.status !== "RESERVED" || existing.quotaDay === quotaDay))
        return { reservationId: `${context.workspaceId}:${existing.id}` };
      // Project-wide aggregate only: YouTube's insert bucket is shared across workspace accounts.
      const used = await tx.v9InsertLease.count({ where: { projectKey, quotaDay } });
      if (used >= 100)
        throw new ConflictException("YOUTUBE_INSERT_QUOTA: retry after midnight Pacific");
      if (existing) {
        await tx.v9InsertLease.updateMany({
          where: { workspaceId: context.workspaceId, id: existing.id, status: "RESERVED" },
          data: { projectKey, quotaDay },
        });
        return { reservationId: `${context.workspaceId}:${existing.id}` };
      }
      const lease = await tx.v9InsertLease.create({
        data: {
          id: randomUUID(),
          workspaceId: context.workspaceId,
          slotId: slot.id,
          projectKey,
          quotaDay,
        },
      });
      return { reservationId: `${context.workspaceId}:${lease.id}` };
    });
  }
  public async settle(reservation: BudgetReservation): Promise<void> {
    await this.finish(reservation);
  }
  public async release(reservation: BudgetReservation): Promise<void> {
    await this.finish(reservation);
  }
  private async finish(reservation: BudgetReservation): Promise<void> {
    const [workspaceId, id] = reservation.reservationId.split(":");
    if (!workspaceId || !id) throw new Error("Invalid insert lease");
    // Never refund an insert with an uncertain outcome. A dispatched insert stays consumed.
    await this.db.v9InsertLease.updateMany({
      where: { workspaceId, id, status: "DISPATCHED" },
      data: { status: "CONSUMED" },
    });
  }
}
