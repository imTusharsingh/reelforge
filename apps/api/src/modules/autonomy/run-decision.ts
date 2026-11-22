import { ConflictException } from "@nestjs/common";
import { criticReport, criticGatesPass, humanGatesPass } from "@reelforge/contracts";
import { envelopeRoom } from "../usage-budget/run-envelope.js";
import type { Context, Run, Scoped, Json } from "../runs/runs.types.js";

export async function writeDecisionLocked(
  db: Scoped,
  current: Run,
  context: Context,
  decision: "APPROVE" | "REJECT",
  automatic: boolean,
): Promise<{ value: null; payload: Json; eventType?: string }> {
  const id = current.id;
  const previous = await db.runEvent.findFirst({
    where: { runId: id, type: { in: ["approved", "auto_approved", "human_rejected"] } },
  });
  if (previous) {
    if (
      previous.type !==
      (decision === "REJECT" ? "human_rejected" : automatic ? "auto_approved" : "approved")
    )
      throw new ConflictException("Run already decided");
    // A conflicting request never changes the original tap or approval count.
    throw new ConflictException("Decision already recorded");
  }
  if (current.state !== "AWAITING_APPROVAL")
    throw new ConflictException("No final approval requested");
  const step = await db.videoRunStep.findFirst({
    where: { runId: id, key: "CRITIC", state: "SUCCEEDED" },
    orderBy: { attempt: "desc" },
  });
  const report = criticReport(step?.output);
  if (automatic && (current.effectiveAutonomy !== "L3" || current.approvedShortsAtStart < 10))
    throw new ConflictException("L3 is unavailable");
  if (decision === "APPROVE") {
    const budget = await db.budgetEnvelope.findFirst({ where: { runId: id } });
    const gatesPass = automatic ? criticGatesPass(report) : humanGatesPass(report);
    if (!gatesPass || current.pauseReason !== null || !budget || !envelopeRoom(budget, 0)) {
      if (automatic) return fallbackToL2(db, current);
      throw new ConflictException("Approval requires all hard gates and no unresolved pause");
    }
  }
  await db.videoRun.updateMany({
    where: { id },
    data:
      decision === "APPROVE"
        ? { state: "SCHEDULED", pauseReason: null }
        : { effectiveAutonomy: "L2", pauseReason: "HUMAN_REJECTED" },
  });
  return {
    value: null,
    payload: {
      decision,
      actorId: context.userId,
      automatic,
      criticAgreed: report ? report.recommendation === decision : null,
    },
  };
}

export async function fallbackToL2(
  db: Scoped,
  current: Run,
): Promise<{ value: null; payload: Json; eventType: string }> {
  if (current.state !== "AWAITING_APPROVAL" || current.effectiveAutonomy !== "L3")
    throw new ConflictException("Run changed");
  await db.videoRun.updateMany({ where: { id: current.id }, data: { effectiveAutonomy: "L2" } });
  return {
    value: null,
    eventType: "autonomy_fallback",
    payload: { reason: "GATE_FAILED", from: "L3", to: "L2" },
  };
}
