import { criticGatesPass, criticReport, humanGatesPass } from "@reelforge/contracts";

/** Only a decision on the latest critic attempt may authorize its publication. */
export function approvalMatchesCritic(
  approval: { type: string; stepId: string | null } | null,
  critic: { id: string; state: string; output: unknown } | null,
): boolean {
  if (!approval || !critic || critic.state !== "SUCCEEDED" || approval.stepId !== critic.id)
    return false;
  const report = criticReport(critic.output);
  return approval.type === "auto_approved"
    ? criticGatesPass(report)
    : approval.type === "approved" && humanGatesPass(report);
}
