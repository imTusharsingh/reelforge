import type { JSX } from "react";
import { VideoRunStateSchema } from "../../../../packages/contracts/src/foundations";
import type { RunDetailView } from "../../../../packages/contracts/src/run-experience";
import { Badge, Card } from "../../components/ui/primitives";
import { stateLabel } from "./view-model";

export function ProgressStream({ detail, connection }: { detail: RunDetailView; connection: string }): JSX.Element {
  return (
    <Card>
      <div className="rf-toolbar">
        <h2>Run timeline</h2>
        <span role="status"><Badge tone={connection === "Live" ? "success" : "neutral"}>{connection}</Badge></span>
      </div>
      <ol className="rf-timeline">
        {VideoRunStateSchema.options.map((state) => (
          <li key={state} aria-current={detail.run.state === state ? "step" : undefined}>{stateLabel(state)}</li>
        ))}
      </ol>
      {detail.steps.length > 0 && (
        <details>
          <summary>Step attempts</summary>
          <ol className="rf-step-log">
            {detail.steps.map((step) => <li key={step.id}>{step.key} · {stateLabel(step.state)} · Attempt {step.attempt}</li>)}
          </ol>
        </details>
      )}
    </Card>
  );
}
