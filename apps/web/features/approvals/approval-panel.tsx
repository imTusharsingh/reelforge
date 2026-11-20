"use client";
import { useState, type JSX } from "react";
import {
  humanGatesPass,
  type RunDetailView,
} from "../../../../packages/contracts/src/run-experience";
import { latestCritic, pauseLabel } from "../timeline/view-model";
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
  return (
    <section aria-label="Critic report and approval">
      <h2>Critic report</h2>
      <CriticSummary detail={detail} />
      {detail.run.pauseReason && <p role="status">{pauseLabel(detail.run.pauseReason)}</p>}
      {pending && editable && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            className="rf-button"
            style={{ minHeight: 48 }}
            disabled={busy || !humanGatesPass(report) || detail.run.pauseReason !== null}
            onClick={() => void decide("APPROVE")}
          >
            Approve Short
          </button>
          <button
            className="rf-button rf-button--secondary"
            style={{ minHeight: 48 }}
            disabled={busy}
            onClick={() => void decide("REJECT")}
          >
            Reject Short
          </button>
        </div>
      )}
      {saved && <p role="status">{saved}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
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
  return (
    <>
      {" "}
      {detail.artifactUrls
        .flatMap((a) => a.artifacts)
        .filter((a) => a.kind === "final" && a.contentType === "video/mp4")
        .map((a) => (
          <video
            key={a.url}
            src={a.url}
            controls
            preload="metadata"
            style={{ maxWidth: "100%", maxHeight: 400 }}
          />
        ))}
      {report ? (
        <>
          <p>{report.summary}</p>
          <p>Recommendation: {report.recommendation}</p>
          <ul>
            {Object.entries(report.gates).map(([gate, pass]) => (
              <li key={gate}>
                {gate}: {pass ? "Pass" : "Needs attention"}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          Critic evidence is unavailable. Approval is blocked until all hard gates are verified.
        </p>
      )}
    </>
  );
}
