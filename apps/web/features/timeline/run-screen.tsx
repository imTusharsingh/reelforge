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
  action: (path: string, body?: object) => Promise<void>;
} {
  const notify = useNotify();
  const [busy, setBusy] = useState(false);
  const action = async (path: string, body: object = {}): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await runRequest(`runs/${id}/${path}`, workspaceId, body);
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
      {editable &&
        (!["LEARNING", "FAILED", "CANCELED"].includes(detail.run.state) ||
          detail.steps.some((step) => step.confirmTerminalText)) && (
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
  const visible = Boolean(paused || error);
  return (
    <div className="rf-run-status-space" aria-hidden={!visible} tabIndex={visible ? 0 : undefined}>
      {visible && (
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
      )}
    </div>
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
      <AbandonControls detail={detail} controls={controls} />
      {(detail.run.pauseReason === "OPERATOR_ABANDONED" ||
        detail.run.pauseReason === "EMERGENCY_STOP") && (
        <Button disabled={busy} onClick={() => void action("resume")}>
          Resume run
        </Button>
      )}
    </div>
  );
}

function AbandonControls({
  detail,
  controls: { action, busy },
}: Pick<RunContentProps, "detail" | "controls">): JSX.Element {
  const owner = useActiveWorkspace().role === "OWNER";
  return (
    <>
      {" "}
      {detail.steps
        .filter((step) =>
          step.confirmTerminalText
            ? owner
            : (detail.run.pauseReason?.startsWith("RECONCILE_REQUIRED") ||
                detail.run.pauseReason === "OPERATOR_ABANDONED") &&
              step.state === "RUNNING" &&
              detail.run.pauseReason.includes(step.id) &&
              (step.key.startsWith("media:") || step.key.startsWith("shot-")),
        )
        .map((step) => (
          <Button
            key={step.id}
            disabled={busy}
            tone="danger"
            onClick={() => {
              const text = step.confirmTerminalText;
              if (
                window.confirm(
                  text
                    ? detail.run.state === "FAILED"
                      ? `Confirm the provider call ended and settle the ${dollars(step.costMinor ?? 0)} charge?`
                      : `Have you confirmed the provider call ended? Book the reserved estimate (${dollars(step.costMinor ?? 0)}) and end this run without retrying.`
                    : "Abandon this attempt? Only a confirmed undispatched attempt can release its reservation.",
                )
              )
                void action(
                  `steps/${step.id}/abandon`,
                  text ? { confirmedTerminalText: true } : {},
                );
            }}
          >
            {step.confirmTerminalText
              ? detail.run.state === "FAILED"
                ? "Settle terminal text call"
                : "Confirm terminal text call and end run"
              : `Abandon ${step.key}`}
          </Button>
        ))}
    </>
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
              : detail.run.pauseReason?.startsWith("RECONCILE_REQUIRED")
                ? "Awaiting reconciliation"
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
        <RunBudget detail={detail} workspaceId={workspaceId} />
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

function RunBudget({
  detail,
  workspaceId,
}: Pick<RunContentProps, "detail" | "workspaceId">): JSX.Element {
  return (
    <Card>
      <h2>Run budget</h2>
      <RunCost workspaceId={workspaceId} id={detail.run.id} revision={detail} />
      {detail.remainingBudgetMinor !== undefined && (
        <p>{dollars(detail.remainingBudgetMinor)} remaining</p>
      )}
      <a href="/runs/usage">Run usage</a>
      {detail.envelope ? (
        <Budget envelope={detail.envelope} />
      ) : (
        <p>
          The budget envelope is set after shot planning.
          {detail.pinnedHardCapMinor !== undefined &&
            ` Pinned cap ${dollars(detail.pinnedHardCapMinor)}.`}
        </p>
      )}
    </Card>
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
