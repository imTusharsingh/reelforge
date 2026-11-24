import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import {
  autonomyPolicy,
  criticReport,
  criticGatesPass,
  type AutonomyLevel,
  type RunAutonomyStatus,
} from "@reelforge/contracts";
import { writeDecisionLocked, fallbackToL2 } from "./run-decision.js";
import { RunsStore } from "../runs/runs.store.js";
import type { Context, Run } from "../runs/runs.types.js";
import { EMERGENCY_STOP_PORT, type EmergencyStopPort } from "../admin/emergency-stop.types.js";

/** V8 decisions use V3's revision lock and event log, never a second run state machine. */
@Injectable()
export class AutonomyService {
  public constructor(
    public readonly store: RunsStore,
    @Inject(EMERGENCY_STOP_PORT) private readonly stop: EmergencyStopPort,
  ) {}
  public async status(context: Context, run: Run): Promise<RunAutonomyStatus> {
    const db = this.store.scoped(context);
    const approvedShorts = await db.runEvent.count({
      where: { type: "approved", run: { channelId: run.channelId } },
    });
    const taps = await db.runEvent.findMany({
      where: { type: { in: ["approved", "human_rejected"] }, run: { channelId: run.channelId } },
      orderBy: { occurredAt: "desc" },
      distinct: ["runId"],
      take: 10,
    });
    const samples = taps.filter((tap) => this.agreement(tap.payload) !== null);
    const agreements = samples.filter((tap) => this.agreement(tap.payload) === true).length;
    return {
      approvedShorts,
      ...autonomyPolicy(run.requestedAutonomy, approvedShorts),
      agreements,
      samples: samples.length,
      recommended: samples.length === 10 && agreements >= 8,
    };
  }
  private agreement(payload: unknown): boolean | null {
    if (!payload || typeof payload !== "object" || !("criticAgreed" in payload)) return null;
    return typeof payload.criticAgreed === "boolean" ? payload.criticAgreed : null;
  }
  private editor(context: Context): void {
    if (context.role === "VIEWER") throw new ForbiddenException("Editor permission required");
  }
  public async select(context: Context, id: string, requested: AutonomyLevel): Promise<void> {
    this.editor(context);
    const run = await this.store.get(context, id);
    if (requested === "L3" && run.approvedShortsAtStart < 10)
      throw new ConflictException("L3 requires ten approved Shorts before this run started");
    await this.store.mutate(context, id, "autonomy_selected", async (db, current) => {
      if (current.state !== "PLANNING")
        throw new ConflictException("Select autonomy before planning starts");
      await db.videoRun.updateMany({
        where: { id },
        data: {
          requestedAutonomy: requested,
          effectiveAutonomy: autonomyPolicy(requested, current.approvedShortsAtStart).effective,
        },
      });
      return { value: null, payload: { requested, actorId: context.userId } };
    });
  }
  public async decide(
    context: Context,
    id: string,
    decision: "APPROVE" | "REJECT",
    automatic = false,
  ): Promise<void> {
    this.editor(context);
    const replay = await this.store.scoped(context).runEvent.findFirst({
      where: { runId: id, type: { in: ["approved", "auto_approved", "human_rejected"] } },
    });
    if (replay) {
      const expected =
        decision === "REJECT" ? "human_rejected" : automatic ? "auto_approved" : "approved";
      if (replay.type !== expected) throw new ConflictException("Run already decided");
      return;
    }
    const run = await this.store.get(context, id);
    const stopped = await this.stop.check({
      workspaceId: context.workspaceId,
      channelId: run.channelId,
    });
    if (stopped.stopped) throw new ConflictException("Emergency stop is active");
    await this.store.mutate(
      context,
      id,
      decision === "APPROVE" ? (automatic ? "auto_approved" : "approved") : "human_rejected",
      (db, current, tx) => writeDecisionLocked(db, tx, current, context, decision, automatic),
    );
  }
  public async settle(context: Context, run: Run): Promise<void> {
    if (run.effectiveAutonomy !== "L3" || run.state !== "AWAITING_APPROVAL") return;
    const step = await this.store.scoped(context).videoRunStep.findFirst({
      where: { runId: run.id, key: "CRITIC", state: "SUCCEEDED" },
      orderBy: { attempt: "desc" },
    });
    if (
      criticGatesPass(criticReport(step?.output)) &&
      run.pauseReason === null &&
      run.approvedShortsAtStart >= 10
    ) {
      await this.decide(context, run.id, "APPROVE", true);
      return;
    }
    await this.store.mutate(context, run.id, "autonomy_fallback", (db, current) =>
      fallbackToL2(db, current),
    );
  }
}
