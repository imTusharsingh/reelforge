"use client";

import { useEffect, useState, type JSX } from "react";
import Link from "next/link";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { useActiveWorkspace } from "../../../components/studio-workspace-context";
import { runClient } from "../../../features/timeline/client";
import { RunCost } from "../../../features/timeline/run-cost";

export default function UsagePage(): JSX.Element {
  return (
    <AuthWorkspace>
      <ActiveUsage />
    </AuthWorkspace>
  );
}

function ActiveUsage(): JSX.Element {
  const workspace = useActiveWorkspace();
  return <WorkspaceUsage key={workspace.id} workspaceId={workspace.id} />;
}

function WorkspaceUsage({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof runClient.list>> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void runClient
      .list(workspaceId)
      .then((rows) => {
        if (active) setRuns(rows);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return (): void => {
      active = false;
    };
  }, [workspaceId]);
  return (
    <section className="rf-stack">
      <h1>Run usage</h1>
      {error && <p role="alert">Runs unavailable.</p>}
      {!runs && !error && <p>Loading runs…</p>}
      {runs?.length === 0 && <p>No runs yet.</p>}
      {runs?.map((run) => (
        <article key={run.id}>
          <Link href={`/runs/${run.id}`}>Short {run.id.slice(0, 8)}</Link>
          <RunCost workspaceId={workspaceId} id={run.id} />
        </article>
      ))}
    </section>
  );
}
