"use client";

import { useState, type JSX } from "react";
import type { RunDetailView } from "../../../../packages/contracts/src/run-experience";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Alert, Badge, Button, Card } from "../../components/ui/primitives";
import { Skeleton, Toast } from "../../components/ui/studio";
import { Tabs } from "../../components/ui/tabs";
import { AutonomyPanel } from "./autonomy-panel";
import { ProgressStream } from "./progress-stream";
import { Storyboard } from "./storyboard";
import { useRun } from "./use-run";
import { runRequest } from "./client";
import { dollars, pauseLabel, stateLabel } from "./view-model";
import { ApprovalPanel, CriticSummary } from "../approvals/approval-panel";

export function RunScreen({ id, review = false }: { id: string; review?: boolean }): JSX.Element {
  const workspace = useActiveWorkspace();
  return <RunWorkspace key={`${workspace.id}:${id}`} id={id} workspaceId={workspace.id} editable={workspace.role !== "VIEWER"} review={review} />;
}

function RunWorkspace({ id, workspaceId, editable, review }: {
  id: string; workspaceId: string; editable: boolean; review: boolean;
}): JSX.Element {
  const { detail, error, connection, refresh } = useRun(workspaceId, id);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const action = async (path: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await runRequest(`runs/${id}/${path}`, workspaceId, {});
      setNotice(path === "approve" ? "Stage approved." : "Shot redo request submitted.");
      refresh();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!detail) return error ? <Alert tone="danger" title="Run unavailable">{error} <Button tone="secondary" onClick={refresh}>Retry</Button></Alert> : <Skeleton label="Loading run…" />;
  const href = `/runs/${id}`;
  const redo = editable && detail.run.state === "CRITIC" ? (ordinal: number): void => { void action(`reshoot/${ordinal}`); } : undefined;
  return (
    <section className="rf-stack">
      <header className="rf-page-heading rf-toolbar">
        <h1>{review ? "Review Short" : `Short ${id.slice(0, 8)}`}</h1>
        <Badge tone="info">{stateLabel(detail.run.state)}</Badge>
      </header>
      <Tabs label="Run views" items={[{ href, label: "Live run" }, { href: href + "/review", label: "Review" }]} current={review ? href + "/review" : href} />
      {(error || actionError) && <Alert tone="danger" title="Run needs attention">{actionError || error}</Alert>}
      {notice && <Toast>{notice}</Toast>}
      {detail.run.pauseReason && <Alert tone="warning" title="Run status">{pauseLabel(detail.run.pauseReason)}</Alert>}
      {review ? <ApprovalPanel detail={detail} workspaceId={workspaceId} editable={editable} refresh={refresh} /> :
        <LiveRun detail={detail} connection={connection} workspaceId={workspaceId} editable={editable} busy={busy} refresh={refresh} approve={() => void action("approve")} />}
      <Storyboard detail={detail} onRedo={redo} busy={busy} />
    </section>
  );
}

function LiveRun({ detail, connection, workspaceId, editable, busy, refresh, approve }: {
  detail: RunDetailView; connection: string; workspaceId: string; editable: boolean;
  busy: boolean; refresh: () => void; approve: () => void;
}): JSX.Element {
  const waiting = detail.run.effectiveAutonomy === "L1" && detail.steps.some((step) => step.state === "WAITING_APPROVAL");
  return (
    <div className="rf-columns">
      <ProgressStream detail={detail} connection={connection} />
      <div className="rf-stack">
        <Card>
          <h2>Run budget</h2>
          {detail.envelope ? <Budget envelope={detail.envelope} /> : <p>Budget envelope unavailable.</p>}
        </Card>
        {waiting && editable && <Button loading={busy} onClick={approve}>Approve stage</Button>}
        <Card><h2>Critic verdict</h2><CriticSummary detail={detail} /></Card>
        <Card><AutonomyPanel workspaceId={workspaceId} run={detail.run} editable={editable} refresh={refresh} /></Card>
      </div>
    </div>
  );
}

function Budget({ envelope }: { envelope: NonNullable<RunDetailView["envelope"]> }): JSX.Element {
  const { spentMinor, hardCapMinor } = envelope;
  return (
    <>
      <p><strong>{dollars(spentMinor)}</strong> used of {dollars(hardCapMinor)} cap</p>
      {hardCapMinor > 0 && <meter aria-label="Run budget used" min={0} max={hardCapMinor} value={Math.min(hardCapMinor, spentMinor)} />}
    </>
  );
}
