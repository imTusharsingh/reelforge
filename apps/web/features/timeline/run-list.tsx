"use client";

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { RunDetailView, RunSummary } from "../../../../packages/contracts/src/run-experience";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge, Button } from "../../components/ui/primitives";
import { EmptyState, Skeleton, VideoPlayer } from "../../components/ui/studio";
import { useResource } from "../../components/ui/use-resource";
import { PageHeading } from "../../components/ui/page-heading";
import { Icon, type IconName } from "../../components/ui/icon";
import { NewShort } from "./new-short";
import { runClient } from "./client";
import {
  dollars,
  finalMedia,
  isPublishedRun,
  needsAttention,
  pauseLabel,
  runMetadata,
  stateLabel,
} from "./view-model";

export function RunList({ inbox = false }: { inbox?: boolean }): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <RunGallery
      key={workspace.id}
      workspaceId={workspace.id}
      inbox={inbox}
      editable={workspace.role !== "VIEWER"}
    />
  );
}

function RunGallery({
  workspaceId,
  inbox,
  editable,
}: {
  workspaceId: string;
  inbox: boolean;
  editable: boolean;
}): JSX.Element {
  const load = useCallback(() => runClient.list(workspaceId), [workspaceId]);
  const { data: runs, error, loading, retry } = useResource(load, 15000);
  const attention = runs?.filter(needsAttention);
  const visible = inbox ? attention : runs;
  return (
    <section className="rf-stack rf-run-library">
      <PageHeading
        label={inbox ? "02 / Review" : "01 / Production"}
        title={inbox ? "Review queue" : "Creator studio"}
        hero
        actions={
          inbox ? undefined : (
            <>
              <StudioLink className="rf-button rf-button--secondary" href="/runs/usage">
                Run usage
              </StudioLink>
              {editable && <NewShort onQueued={retry} />}
            </>
          )
        }
      >
        {inbox
          ? "Open a Short to check its preview and make a decision."
          : "Track your Shorts from the first idea to the published video."}
      </PageHeading>
      {!inbox && runs && (
        <WorkspaceSnapshot
          runs={runs.length}
          attention={attention?.length ?? 0}
          published={runs.filter(isPublishedRun).length}
        />
      )}
      {error && (
        <Alert
          tone={runs ? "warning" : "danger"}
          title={runs ? "Couldn’t refresh Shorts" : "Runs unavailable"}
        >
          {runs ? "Showing the last loaded Shorts." : error}
          <div className="rf-action-row">
            <Button tone="secondary" loading={loading} onClick={retry}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {!runs && !error && <Skeleton label="Loading runs…" />}
      {visible && <RunCards runs={visible} workspaceId={workspaceId} inbox={inbox} />}
    </section>
  );
}

function RunCards({
  runs,
  workspaceId,
  inbox,
}: {
  runs: RunSummary[];
  workspaceId: string;
  inbox: boolean;
}): JSX.Element {
  return (
    <>
      {runs.length === 0 && (
        <EmptyState title={inbox ? "Nothing to review" : "No Shorts yet"}>
          <p>
            {inbox
              ? "Shorts that need attention will appear here."
              : "Choose New Short to queue a run from a saved Channel Brief."}
          </p>
        </EmptyState>
      )}
      {runs.length > 0 && (
        <>
          <div className="rf-section-heading">
            <h2>{inbox ? "Needs attention" : "Your Shorts"}</h2>
            <span>
              {runs.length} {runs.length === 1 ? "Short" : "Shorts"}
            </span>
          </div>
          <ul className="rf-grid rf-gallery">
            {runs.map((run) => (
              <RunTile key={run.id} run={run} workspaceId={workspaceId} inbox={inbox} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function WorkspaceSnapshot({
  runs,
  attention,
  published,
}: {
  runs: number;
  attention: number;
  published: number;
}): JSX.Element {
  const stats: { label: string; value: number; icon: IconName }[] = [
    { label: "Shorts loaded", value: runs, icon: "film" },
    { label: "Needs attention", value: attention, icon: "review" },
    { label: "Published", value: published, icon: "calendar" },
  ];
  return (
    <section aria-labelledby="workspace-snapshot-heading">
      <h2 className="rf-muted" id="workspace-snapshot-heading">
        Latest 100 Shorts
      </h2>
      <dl className="rf-snapshot">
        {stats.map(({ label, value, icon }) => (
          <div key={label}>
            <dt>
              <Icon name={icon} /> {label}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function useTileDetail(
  workspaceId: string,
  run: RunSummary,
  target: { current: HTMLLIElement | null },
): { detail: RunDetailView | null; unavailable: boolean } {
  const [detail, setDetail] = useState<RunDetailView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = target.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [target]);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const load = (): void => {
      void runClient.detail(workspaceId, run.id).then(
        (value) => {
          if (active) {
            setDetail(value);
            setUnavailable(false);
          }
        },
        () => {
          if (active) setUnavailable(true);
        },
      );
    };
    load();
    const timer = setInterval(load, 15000);
    return (): void => {
      active = false;
      clearInterval(timer);
    };
  }, [workspaceId, run.id, run.state, visible]);
  return { detail, unavailable };
}

function runBadgeTone(run: RunSummary): "success" | "warning" | "neutral" {
  if (isPublishedRun(run)) return "success";
  return needsAttention(run) ? "warning" : "neutral";
}

function RunTile({
  run,
  workspaceId,
  inbox,
}: {
  run: RunSummary;
  workspaceId: string;
  inbox: boolean;
}): JSX.Element {
  const target = useRef<HTMLLIElement>(null);
  const { detail, unavailable } = useTileDetail(workspaceId, run, target);
  const media = detail ? finalMedia(detail) : {};
  const title = (detail && runMetadata(detail)?.title) || `Short ${run.id.slice(0, 8)}`;
  return (
    <li ref={target} className="rf-run-tile">
      <StudioLink className="rf-run-link" href={`/runs/${run.id}${inbox ? "/review" : ""}`}>
        <VideoPlayer
          preview
          src={media.video}
          poster={media.poster}
          label={
            media.poster
              ? `Thumbnail for ${title}`
              : media.video
                ? `Preview of ${title}`
                : unavailable
                  ? "Preview unavailable"
                  : detail
                    ? "No preview yet"
                    : "Loading preview…"
          }
        />
        <div className="rf-run-caption">
          <strong>{title}</strong>
          <span className="rf-cluster">
            <Badge tone={runBadgeTone(run)}>
              {run.pauseReason === "PUBLISH_DRY_RUN" ? "Dry run" : stateLabel(run.state)}
            </Badge>
            <span>
              {detail?.envelope
                ? dollars(detail.envelope.spentMinor)
                : detail || unavailable
                  ? "Cost unavailable"
                  : "Loading cost…"}
            </span>
          </span>
          {run.pauseReason && run.pauseReason !== "PUBLISH_DRY_RUN" && (
            <p>{pauseLabel(run.pauseReason)}</p>
          )}
        </div>
      </StudioLink>
    </li>
  );
}
