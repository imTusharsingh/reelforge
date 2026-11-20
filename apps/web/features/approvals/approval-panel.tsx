"use client";
import { useState, type JSX } from "react";
import {
  humanGatesPass,
  type RunDetailView,
} from "../../../../packages/contracts/src/run-experience";
import { finalMedia, latestCritic, runMetadata } from "../timeline/view-model";
import { Badge, Button, Card, Alert } from "../../components/ui/primitives";
import { Toast, VideoPlayer } from "../../components/ui/studio";
import { runRequest } from "../timeline/client";

export function ApprovalPanel({
  detail,
  workspaceId,
  editable,
  refresh,
}: {
  detail: RunDetailView;
  workspaceId: string;
  editable: boolean;
  refresh: () => void;
}): JSX.Element {
  const { busy, error, saved, decide } = useDecision(detail.run.id, workspaceId, refresh);
  const report = latestCritic(detail);
  const pending =
    detail.run.state === "AWAITING_APPROVAL" &&
    detail.run.pauseReason !== "HUMAN_REJECTED" &&
    !saved;
  const media = finalMedia(detail);
  return (
    <section className="rf-review" aria-label="Review Short">
      <div className="rf-player-card">
        <VideoPlayer
          src={media.video}
          poster={media.poster}
          label={media.video ? "Final Short preview" : "Final video not available"}
        />
      </div>
      <div className="rf-stack">
        <ReviewMetadata detail={detail} poster={media.poster} />
        <Card>
          <h2>Approval</h2>
          <p>
            The first 10 Shorts require human approval before publishing. This run started with{" "}
            {detail.run.approvedShortsAtStart} approved Shorts for its channel.
          </p>
          <CriticSummary detail={detail} />
          {pending && editable && (
            <DecisionActions
              busy={busy}
              canApprove={humanGatesPass(report) && detail.run.pauseReason === null}
              decide={decide}
            />
          )}
          {detail.run.state === "CRITIC" && editable && <a href="#storyboard">Redo a shot</a>}
          {detail.run.state === "AWAITING_APPROVAL" && (
            <p>Shot redo is available during Critic review.</p>
          )}
          {saved && <Toast>{saved}</Toast>}
          {error && (
            <Alert tone="danger" title="Decision failed">
              {error}
            </Alert>
          )}
        </Card>
      </div>
    </section>
  );
}

function DecisionActions({
  busy,
  canApprove,
  decide,
}: {
  busy: boolean;
  canApprove: boolean;
  decide: ReturnType<typeof useDecision>["decide"];
}): JSX.Element {
  return (
    <div className="rf-actions">
      <Button disabled={busy || !canApprove} onClick={() => void decide("APPROVE")}>
        Approve Short
      </Button>
      <Button tone="danger" disabled={busy} onClick={() => void decide("REJECT")}>
        Reject Short
      </Button>
    </div>
  );
}
function ReviewMetadata({
  detail,
  poster,
}: {
  detail: RunDetailView;
  poster: string | undefined;
}): JSX.Element {
  const metadata = runMetadata(detail);
  return (
    <Card>
      <h2>Publishing details</h2>
      {metadata ? (
        <dl className="rf-metadata">
          <dt>Title</dt>
          <dd>{metadata.title}</dd>
          <dt>Description</dt>
          <dd>{metadata.description || "No description"}</dd>
          <dt>Tags</dt>
          <dd className="rf-cluster">
            {metadata.tags.length
              ? metadata.tags.map((tag, index) => <Badge key={`${tag}:${index}`}>{tag}</Badge>)
              : "No tags"}
          </dd>
        </dl>
      ) : (
        <p>Publishing details are unavailable for this run.</p>
      )}
      <h3>Thumbnail</h3>
      {poster ? (
        <div className="rf-cover">
          <VideoPlayer preview poster={poster} label="Short thumbnail" />
        </div>
      ) : (
        <p>Thumbnail unavailable.</p>
      )}
    </Card>
  );
}

function useDecision(
  id: string,
  workspaceId: string,
  refresh: () => void,
): {
  busy: boolean;
  error: string;
  saved: string;
  decide: (decision: "APPROVE" | "REJECT") => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const decide = async (decision: "APPROVE" | "REJECT"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await runRequest(`run-experience/${id}/decision`, workspaceId, { decision });
      setSaved(
        decision === "APPROVE"
          ? "Approved. Ready for scheduling."
          : "Rejected. Publishing is blocked.",
      );
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, decide };
}

export function CriticSummary({ detail }: { detail: RunDetailView }): JSX.Element {
  const report = latestCritic(detail);
  if (!report) return <p>Critic evidence is unavailable. Approval requires all hard gates.</p>;
  return (
    <div className="rf-stack">
      <Badge tone={report.recommendation === "APPROVE" ? "success" : "warning"}>
        {report.recommendation === "APPROVE" ? "Recommend approval" : "Recommend rejection"}
      </Badge>
      <p>{report.summary}</p>
      <ul className="rf-verdicts">
        {Object.entries(report.gates).map(([gate, pass]) => (
          <li key={gate}>
            <span>{gate}</span>
            <Badge tone={pass ? "success" : "warning"}>{pass ? "Pass" : "Needs attention"}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
