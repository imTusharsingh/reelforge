import type { M29Context } from "./api";
import type { WorkflowRun } from "./types";

export function redacted(message: string | null): string {
  if (!message) return "No additional detail was provided.";
  return message
    .replace(
      /(bearer\s+|api[_-]?key|token|secret|password|authorization)[^\s,;]*/gi,
      "$1[redacted]",
    )
    .slice(0, 240);
}

export function safeActions(
  run: WorkflowRun,
  role: M29Context["role"],
): readonly ("cancel" | "retry" | "resume")[] {
  if (role === "VIEWER") return [];
  if (["RUNNING", "QUEUED", "WAITING_APPROVAL", "RETRY_WAIT"].includes(run.state))
    return ["cancel"];
  if (
    run.state === "FAILED" &&
    run.steps.some((step) => ["FAILED_FINAL", "RECONCILIATION_REQUIRED"].includes(step.status))
  )
    return ["retry"];
  if (run.state === "PAUSED") return ["resume", "cancel"];
  return [];
}
