import { criticGatesPass, criticReport, humanGatesPass } from "@reelforge/contracts";

/** Only a decision on the latest successful critic may authorize its publication. */
export function approvalMatchesCritic(
  approval: { type: string; stepId: string | null } | null,
  critic: { id: string; output: unknown } | null,
): boolean {
  if (!approval || !critic || approval.stepId !== critic.id) return false;
  const report = criticReport(critic.output);
  return approval.type === "auto_approved"
    ? criticGatesPass(report)
    : approval.type === "approved" && humanGatesPass(report);
}
