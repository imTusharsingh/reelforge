"use client";
import { useEffect, useState, type JSX } from "react";
import {
  LearnedChangeSchema,
  type LearnedChange,
} from "../../../../packages/contracts/src/discovery";
import { Skeleton } from "../../components/ui/studio";
import { Panel, StateMessage } from "../../components/ui/primitives";

function useLearnedChanges(
  workspaceId: string,
  channelId: string,
): { changes: LearnedChange[]; status: string } {
  const [changes, setChanges] = useState<LearnedChange[]>([]);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    setChanges([]);
    if (!channelId) return;
    setStatus("Loading learned changes…");
    void fetch(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/learning`,
      { credentials: "include" },
    )
      .then(async (response): Promise<LearnedChange[]> => {
        if (!response.ok) throw new Error("Learned changes are unavailable.");
        return LearnedChangeSchema.array().parse(await response.json());
      })
      .then((rows) => {
        if (active) {
          setChanges(rows);
          setStatus(
            rows.length
              ? ""
              : "No learned changes yet. Learning requires at least three Shorts with complete retention evidence.",
          );
        }
      })
      .catch(() => {
        if (active) setStatus("Learned changes are unavailable.");
      });
    return (): void => {
      active = false;
    };
  }, [workspaceId, channelId]);
  return { changes, status };
}
export function LearnedChanges({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}): JSX.Element {
  const { changes, status } = useLearnedChanges(workspaceId, channelId);
  return (
    <Panel>
      <h2>What the AI learned</h2>
      <p>
        Scoring weights and format mix can change within your Brief’s bounds, at most 0.05 per week.
        Prompt and configuration changes remain recommendations.
      </p>
      {status.startsWith("Loading") ? (
        <Skeleton label={status} />
      ) : (
        status && (
          <StateMessage
            kind={status.includes("unavailable") ? "error" : "empty"}
            description={status}
          />
        )
      )}
      {changes.map((change) => (
        <article key={change.id}>
          <h3>
            {change.mode === "APPLIED" ? "Applied learning" : "Recommendation"} · Week of{" "}
            {change.week}
          </h3>
          <p>{change.reason}</p>
          <WeightChanges
            before={change.before.weights}
            after={change.after.weights}
            label="Scoring weights"
          />
          <WeightChanges
            before={change.before.formatMix}
            after={change.after.formatMix}
            label="Format mix"
          />
          <p>Evidence snapshots: {change.evidenceSnapshotIds.join(", ")}</p>
        </article>
      ))}
    </Panel>
  );
}
function WeightChanges({
  before,
  after,
  label,
}: {
  before: Record<string, number>;
  after: Record<string, number>;
  label: string;
}): JSX.Element {
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <ul>
        {Object.keys(before)
          .filter((key) => before[key] !== after[key])
          .map((key) => (
            <li key={key}>
              {key}: {before[key]!.toFixed(3)} → {after[key]!.toFixed(3)}
            </li>
          ))}
      </ul>
    </section>
  );
}
