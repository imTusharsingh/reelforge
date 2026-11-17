"use client";
import { useEffect, useState, type JSX } from "react";
import type { RunSummary } from "../../../../packages/contracts/src/run-experience";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { runClient } from "./client";
import { InboxCard } from "../approvals/inbox-card";
import { pauseLabel } from "./view-model";

export function RunList({ inbox = false }: { inbox?: boolean }): JSX.Element {
  const workspace = useActiveWorkspace();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const data = await runClient.list(workspace.id);
        if (active) {
          setRuns(data);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return (): void => {
      active = false;
      clearInterval(timer);
    };
  }, [workspace.id]);
  const visible = inbox
    ? runs.filter(
        (run) =>
          ["AWAITING_APPROVAL", "PAUSED_BUDGET", "NEEDS_HUMAN", "FAILED"].includes(run.state) &&
          run.pauseReason !== "HUMAN_REJECTED",
      )
    : runs;
  return (
    <section>
      <h1>{inbox ? "Approval inbox" : "Run timeline"}</h1>
      <p>{listIntroduction(inbox)}</p>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading runs…</p>}
      {!loading && !visible.length && <p>No {inbox ? "Shorts need attention" : "runs yet"}.</p>}
      <ul>
        {visible.map((run) => (
          <li key={run.id}>
            <RunRow
              run={run}
              inbox={inbox}
              workspaceId={workspace.id}
              editable={workspace.role !== "VIEWER"}
            />
          </li>
        ))}
      </ul>
      <StudioLink href="/usage">View usage</StudioLink>
    </section>
  );
}

function RunRow({
  run,
  inbox,
  workspaceId,
  editable,
}: {
  run: RunSummary;
  inbox: boolean;
  workspaceId: string;
  editable: boolean;
}): JSX.Element {
  return (
    <>
      {" "}
      {inbox ? (
        <InboxCard id={run.id} workspaceId={workspaceId} editable={editable} />
      ) : (
        <>
          <StudioLink href={`/runs/${run.id}`}>Short {run.id.slice(0, 8)}</StudioLink> — {run.state}{" "}
          · {run.effectiveAutonomy}
          {run.pauseReason && <p>{pauseLabel(run.pauseReason)}</p>}
        </>
      )}
    </>
  );
}

function listIntroduction(inbox: boolean): string {
  return inbox
    ? "Review the critic report and approve or reject a Short with one tap."
    : "Watch each Short from planning through publishing.";
}
