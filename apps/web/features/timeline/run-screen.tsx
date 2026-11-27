"use client";

import { useState, type JSX } from "react";
import type { TimelineDetail } from "./client";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Alert, Badge, Button, Card } from "../../components/ui/primitives";
import { Skeleton } from "../../components/ui/studio";
import { useNotify } from "../../components/ui/notifications";
import { Tabs } from "../../components/ui/tabs";
import { AutonomyPanel } from "./autonomy-panel";
import { ProgressStream } from "./progress-stream";
import { Storyboard } from "./storyboard";
import { useRun } from "./use-run";
import { RunCost } from "./run-cost";
import { runRequest } from "./client";
import { PageHeading } from "../../components/ui/page-heading";
import { dollars, runMetadata, runPauseLabel, stateLabel } from "./view-model";
import { ApprovalPanel, CriticSummary } from "../approvals/approval-panel";

export function RunScreen({ id, review = false }: { id: string; review?: boolean }): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <RunWorkspace
      key={`${workspace.id}:${id}`}
      id={id}
      workspaceId={workspace.id}
      editable={workspace.role !== "VIEWER"}
      review={review}
    />
  );
}

function RunWorkspace({
  id,
  workspaceId,
  editable,
  review,
}: {
  id: string;
  workspaceId: string;
  editable: boolean;
  review: boolean;
}): JSX.Element {
  const { detail, error, connection, refresh } = useRun(workspaceId, id);
  const controls = useRunActions(workspaceId, id, refresh);
  if (!detail)
    return error ? (
      <Alert tone="danger" title="Run unavailable">
        {error}{" "}
        <Button tone="secondary" onClick={refresh}>
          Retry
        </Button>
      </Alert>
    ) : (
      <Skeleton label="Loading run…" />
    );
  return (
    <RunContent
      detail={detail}
      workspaceId={workspaceId}
      editable={editable}
      review={review}
      connection={connection}
      error={error}
      refresh={refresh}
      controls={controls}
    />
  );
}

function useRunActions(
  workspaceId: string,
  id: string,
  refresh: () => void,
): {
  busy: boolean;
  action: (path: string) => Promise<void>;
} {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const action = async (path: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await runRequest(`runs/${id}/${path}`, workspaceId, {});
      notify({ tone: "success", title: path === "approve" ? "Stage approved." : "Run updated." });
      refresh();
    } catch (e) {
      notify({
        tone: "danger",
        title: "Run action failed",
        detail: e instanceof Error ? e.message : "Try again from the run controls.",
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, action };
}

type RunContentProps = {
  detail: TimelineDetail;
  workspaceId: string;
  editable: boolean;
  review: boolean;
  connection: string;
  error: string;
  refresh: () => void;
  controls: ReturnType<typeof useRunActions>;
};
function RunContent({
  detail,
  workspaceId,
  editable,
  review,
  connection,
  error,
  refresh,
  controls,
}: RunContentProps): JSX.Element {
  const { action, busy } = controls;
  const redo =
    editable && detail.run.state === "CRITIC" && !detail.run.pauseReason
      ? (ordinal: number, sourceStepId: string): void => {
          void action(`reshoot/${ordinal}?sourceStepId=${encodeURIComponent(sourceStepId)}`);
        }
      : undefined;
  return (
    <section className="rf-stack">
      <RunHeading detail={detail} review={review} />
      <RunFeedback paused={runPauseLabel(detail)} error={error} retry={refresh} />
      {editable && !["LEARNING", "FAILED", "CANCELED"].includes(detail.run.state) && (
        <RunOperatorControls detail={detail} controls={controls} />
      )}
      {review ? (
        <ApprovalPanel
          detail={detail}
          workspaceId={workspaceId}
          editable={editable}
          refresh={refresh}
        />
      ) : (
        <LiveRun
          detail={detail}
          connection={connection}
          workspaceId={workspaceId}
          editable={editable}
          busy={busy}
          refresh={refresh}
          approve={() => void action("approve")}
        />
      )}
      <Storyboard detail={detail} onRedo={redo} busy={busy} />
    </section>
  );
}

function RunFeedback({
  paused,
  error,
  retry,
}: {
  paused: string;
  error: string;
  retry: () => void;
}): JSX.Element | null {
  if (!paused && !error) return null;
  return (
    <Alert tone={error ? "danger" : "warning"} title="Run status">
      {paused && <div>{paused}</div>}
      {error && (
        <div className="rf-action-row">
          <span>Couldn’t refresh the run. Showing the last loaded status.</span>
          <Button tone="secondary" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
    </Alert>
  );
}

function RunOperatorControls({
  detail,
  controls,
}: Pick<RunContentProps, "detail" | "controls">): JSX.Element {
  const { action, busy } = controls;
  const cancelable = !["PUBLISHED", "LEARNING", "FAILED", "CANCELED"].includes(detail.run.state);
  return (
    <div className="rf-actions">
      {cancelable && (
        <Button tone="danger" disabled={busy} onClick={() => void action("cancel")}>
          Cancel run
        </Button>
      )}
      {(detail.run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
        detail.run.pauseReason === "OPERATOR_ABANDONED") &&
        detail.steps
          .filter(
            (step) =>
              step.state === "RUNNING" &&
              (step.key.startsWith("media:") || step.key.startsWith("shot-")),
          )
          .map((step) => (
            <Button
              key={step.id}
              disabled={busy}
              onClick={() => void action(`steps/${step.id}/abandon`)}
            >
              Abandon {step.key}
            </Button>
          ))}
      {(detail.run.pauseReason === "OPERATOR_ABANDONED" ||
        detail.run.pauseReason === "EMERGENCY_STOP") && (
        <Button disabled={busy} onClick={() => void action("resume")}>
          Resume run
        </Button>
      )}
    </div>
  );
}

function RunHeading({ detail, review }: { detail: TimelineDetail; review: boolean }): JSX.Element {
  const href = `/runs/${detail.run.id}`;
  const reviewHref = href + "/review";
  const title = runMetadata(detail)?.title ?? `Short ${detail.run.id.slice(0, 8)}`;
  return (
    <>
      <PageHeading
        label={review ? "02 / Review" : "01 / Production"}
        title={review ? "Review Short" : title}
        actions={
          <Badge tone="info">
            {detail.run.pauseReason === "PUBLISH_DRY_RUN"
              ? "Dry run"
              : stateLabel(detail.run.state)}
          </Badge>
        }
      >
        {review ? title : "Follow progress and inspect the artifacts from this run."}
      </PageHeading>
      <Tabs
        label="Run views"
        items={[
          { href, label: "Live run" },
          { href: reviewHref, label: "Review" },
        ]}
        current={review ? reviewHref : href}
      />
    </>
  );
}

function LiveRun({
  detail,
  connection,
  workspaceId,
  editable,
  busy,
  refresh,
  approve,
}: {
  detail: TimelineDetail;
  connection: string;
  workspaceId: string;
  editable: boolean;
  busy: boolean;
  refresh: () => void;
  approve: () => void;
}): JSX.Element {
  const waiting =
    detail.run.effectiveAutonomy === "L1" &&
    detail.steps.some((step) => step.state === "WAITING_APPROVAL");
  return (
    <div className="rf-columns">
      <ProgressStream detail={detail} connection={connection} />
      <div className="rf-stack">
        <Card>
          <h2>Run budget</h2>
          <RunCost workspaceId={workspaceId} id={detail.run.id} revision={detail} />
          <a href="/runs/usage">Run usage</a>
          {detail.envelope ? (
            <Budget envelope={detail.envelope} />
          ) : (
            <p>Budget envelope unavailable.</p>
          )}
        </Card>
        {waiting && editable && (
          <Button loading={busy} onClick={approve}>
            Approve stage
          </Button>
        )}
        <Card>
          <h2>Critic verdict</h2>
          <CriticSummary detail={detail} />
        </Card>
        <Card>
          <AutonomyPanel
            workspaceId={workspaceId}
            run={detail.run}
            editable={editable}
            refresh={refresh}
          />
        </Card>
      </div>
    </div>
  );
}

function Budget({ envelope }: { envelope: NonNullable<TimelineDetail["envelope"]> }): JSX.Element {
  const { spentMinor, hardCapMinor } = envelope;
  return (
    <>
      <p>
        <strong>{dollars(spentMinor)}</strong> used of {dollars(hardCapMinor)} cap
      </p>
      {hardCapMinor > 0 && (
        <meter
          aria-label="Run budget used"
          min={0}
          max={hardCapMinor}
          value={Math.min(hardCapMinor, spentMinor)}
        />
      )}
    </>
  );
}
