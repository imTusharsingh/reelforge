"use client";

import { useEffect, useRef, useState, type JSX } from "react";
import type { RunDetailView, RunSummary } from "../../../../packages/contracts/src/run-experience";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge } from "../../components/ui/primitives";
import { EmptyState, Skeleton, VideoPlayer } from "../../components/ui/studio";
import { runClient } from "./client";
import { dollars, finalMedia, pauseLabel, runMetadata, stateLabel } from "./view-model";

function useRuns(workspaceId: string): { runs: RunSummary[] | null; error: string } {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const data = await runClient.list(workspaceId);
        if (active) {
          setRuns(data);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) timer = setTimeout(() => void load(), 15000);
      }
    };
    void load();
    return (): void => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId]);
  return { runs, error };
}

export function RunList({ inbox = false }: { inbox?: boolean }): JSX.Element {
  const workspace = useActiveWorkspace();
  return <RunGallery key={workspace.id} workspaceId={workspace.id} inbox={inbox} editable={workspace.role !== "VIEWER"} />;
}

function RunGallery({ workspaceId, inbox, editable }: { workspaceId: string; inbox: boolean; editable: boolean }): JSX.Element {
  const { runs, error } = useRuns(workspaceId);
  const visible = runs?.filter((run) => !inbox || (["AWAITING_APPROVAL", "CRITIC", "PAUSED_BUDGET", "NEEDS_HUMAN", "FAILED"].includes(run.state) && run.pauseReason !== "HUMAN_REJECTED"));
  return (
    <section className="rf-stack">
      <header className="rf-page-heading rf-toolbar">
        <div className="rf-stack">
          <h1>{inbox ? "Review queue" : "Creator studio"}</h1>
          <p>{inbox ? "Open a Short to check its preview and make a decision." : "Track your Shorts from the first idea to the published video."}</p>
        </div>
        {!inbox && editable && <StudioLink className="rf-button" href="/onboarding">＋ New channel</StudioLink>}
      </header>
      {error && <Alert tone="danger" title="Runs unavailable">{error}</Alert>}
      {!runs && !error && <Skeleton label="Loading runs…" />}
      {visible?.length === 0 && <EmptyState title={inbox ? "Nothing to review" : "No Shorts yet"}><p>{inbox ? "Shorts that need attention will appear here." : "Create a Channel Brief to queue your first Short."}</p></EmptyState>}
      {visible && visible.length > 0 && <><h2>{inbox ? "Needs attention" : "Your Shorts"}</h2><ul className="rf-grid rf-gallery">{visible.map((run) => <RunTile key={run.id} run={run} workspaceId={workspaceId} inbox={inbox} />)}</ul></>}
    </section>
  );
}

function useTileDetail(workspaceId: string, run: RunSummary, target: { current: HTMLLIElement | null }): { detail: RunDetailView | null; unavailable: boolean } {
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
      void runClient.detail(workspaceId, run.id).then((value) => {
        if (active) { setDetail(value); setUnavailable(false); }
      }, () => {
        if (active) setUnavailable(true);
      });
    };
    load();
    const timer = setInterval(load, 15000);
    return (): void => { active = false; clearInterval(timer); };
  }, [workspaceId, run.id, run.state, visible]);
  return { detail, unavailable };
}

function RunTile({ run, workspaceId, inbox }: { run: RunSummary; workspaceId: string; inbox: boolean }): JSX.Element {
  const target = useRef<HTMLLIElement>(null);
  const { detail, unavailable } = useTileDetail(workspaceId, run, target);
  const media = detail ? finalMedia(detail) : {};
  const title = (detail && runMetadata(detail)?.title) || `Short ${run.id.slice(0, 8)}`;
  return (
    <li ref={target} className="rf-run-tile">
      <StudioLink className="rf-run-link" href={`/runs/${run.id}${inbox ? "/review" : ""}`}>
        <VideoPlayer preview src={media.poster ? undefined : media.video} poster={media.poster} label={media.poster ? `Thumbnail for ${title}` : media.video ? `Preview of ${title}` : unavailable ? "Preview unavailable" : "No preview available"} />
        <div className="rf-run-caption">
          <strong>{title}</strong>
          <span className="rf-cluster">
            <Badge tone={run.state === "PUBLISHED" ? "success" : run.state === "AWAITING_APPROVAL" ? "warning" : "neutral"}>{stateLabel(run.state)}</Badge>
            <span>{detail?.envelope ? dollars(detail.envelope.spentMinor) : "Cost unavailable"}</span>
          </span>
          {run.pauseReason && <p>{pauseLabel(run.pauseReason)}</p>}
        </div>
      </StudioLink>
    </li>
  );
}
