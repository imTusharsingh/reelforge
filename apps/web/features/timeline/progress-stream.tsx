import type { JSX } from "react";
import { VideoRunStateSchema } from "../../../../packages/contracts/src/foundations";
import type { RunDetailView } from "../../../../packages/contracts/src/run-experience";
import { Badge, Card } from "../../components/ui/primitives";
import { stateLabel } from "./view-model";

export function ProgressStream({
  detail,
  connection,
}: {
  detail: RunDetailView;
  connection: string;
}): JSX.Element {
  const completed = completedStages(detail);
  return (
    <Card>
      <div className="rf-toolbar">
        <h2>Run timeline</h2>
        <span role="status">
          <Badge tone={connection === "Live" ? "success" : "neutral"}>{connection}</Badge>
        </span>
      </div>
      <ol className="rf-timeline">
        {VideoRunStateSchema.options
          .filter(
            (state) =>
              state === detail.run.state ||
              !["FAILED", "CANCELED", "PAUSED_BUDGET", "NEEDS_HUMAN"].includes(state),
          )
          .map((state) => {
            const current = detail.run.state === state;
            const simulated =
              current && state === "PUBLISHED" && detail.run.pauseReason === "PUBLISH_DRY_RUN";
            const renderPaused =
              current && (state === "ASSEMBLING" || state === "CRITIC") && detail.run.pauseReason;
            const label = renderPaused
              ? state === "ASSEMBLING"
                ? "Assembly paused"
                : "Critic paused"
              : stateLabel(state);
            return (
              <li key={state} aria-current={current ? "step" : undefined}>
                {!current && completed.has(state) && "✓ "}
                {simulated ? "Publish simulated (dry run)" : label}
              </li>
            );
          })}
      </ol>
      {detail.steps.length > 0 && (
        <details open>
          <summary>Step attempts</summary>
          <ol className="rf-step-log">
            {detail.steps.map((step) => (
              <li key={step.id}>
                {step.key} ·{" "}
                {step.awaitingReconciliation ? "Awaiting reconciliation" : stateLabel(step.state)} ·
                Attempt {step.attempt}
              </li>
            ))}
          </ol>
        </details>
      )}
    </Card>
  );
}

function completedStages(detail: RunDetailView): ReadonlySet<string> {
  return new Set<string>(
    detail.completedStages ??
      detail.steps.filter((step) => step.state === "SUCCEEDED").map((step) => step.key),
  );
}
