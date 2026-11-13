import type { OperationsContext } from "./operations-api";
import type { WorkflowRun } from "./operations-types";

export function canEditOperations(role: OperationsContext["role"]): boolean {
  return role === "OWNER" || role === "EDITOR";
}

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
  role: OperationsContext["role"],
): readonly ("cancel" | "retry" | "resume")[] {
  if (!canEditOperations(role)) return [];
  if (run.state === "WAITING_APPROVAL") return ["resume", "cancel"];
  if (["RUNNING", "QUEUED", "RETRY_WAIT"].includes(run.state)) return ["cancel"];
  if (
    run.state === "FAILED" &&
    run.steps.some((step) => ["FAILED", "RECONCILIATION_REQUIRED"].includes(step.status))
  )
    return ["retry"];
  if (run.state === "PAUSED") return ["resume", "cancel"];
  return [];
}
