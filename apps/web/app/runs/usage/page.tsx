"use client";

import { useCallback, type JSX } from "react";
import Link from "next/link";
import { Alert, Button, Card } from "../../../components/ui/primitives";
import { EmptyState, Skeleton } from "../../../components/ui/studio";
import { useResource } from "../../../components/ui/use-resource";
import { PageHeading } from "../../../components/ui/page-heading";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { useActiveWorkspace } from "../../../components/studio-workspace-context";
import { runClient } from "../../../features/timeline/client";
import { dollars } from "../../../features/timeline/view-model";
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
  const capsLoad = useCallback(() => runClient.caps(workspaceId), [workspaceId]);
  const caps = useResource(capsLoad);
  const load = useCallback(() => runClient.list(workspaceId), [workspaceId]);
  const { data: runs, error, loading, retry } = useResource(load);
  return (
    <section className="rf-stack">
      <PageHeading label="01 / Production" title="Run usage">
        Review actual recorded spend for your Shorts.
      </PageHeading>
      {error && (
        <Alert tone="danger" title="Usage unavailable">
          Run usage could not be loaded.
          <div className="rf-action-row">
            <Button tone="secondary" loading={loading} onClick={retry}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {caps.error && (
        <p role="status">
          Channel caps could not be loaded. <Button onClick={caps.retry}>Retry limits</Button>
        </p>
      )}
      {caps.data?.map((cap) => (
        <p key={cap.channelId}>
          {cap.name} · {"incompatibleCurrencies" in cap ? `USD admission blocked by ${cap.incompatibleCurrencies.join(", ")} budget currency` : `Effective daily cap ${dollars(cap.dailyLimitMinor)} · Monthly cap ${dollars(cap.monthlyLimitMinor)}`}
        </p>
      ))}
      {!runs && !error && <Skeleton label="Loading run usage…" />}
      {runs?.length === 0 && (
        <EmptyState title="No usage to show">
          <p>Recorded spend appears here after your first run.</p>
        </EmptyState>
      )}
      {runs?.map((run) => (
        <Card key={run.id}>
          <Link href={`/runs/${run.id}`}>Short {run.id.slice(0, 8)}</Link>
          <RunCost workspaceId={workspaceId} id={run.id} />
        </Card>
      ))}
    </section>
  );
}
