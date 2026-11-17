"use client";
import { useState, type JSX } from "react";
import { ShotSpecSchema } from "../../../../packages/contracts/src/foundations";
import type { RunDetailView } from "../../../../packages/contracts/src/run-experience";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { ApprovalPanel } from "../approvals/approval-panel";
import { AutonomyPanel } from "./autonomy-panel";
import { useRun } from "./use-run";
import { runRequest } from "./client";
import { dollars } from "./view-model";

function Storyboard({
  detail,
  reshoot,
  busy,
  editable,
}: {
  detail: RunDetailView;
  reshoot: (ordinal: number) => void;
  busy: boolean;
  editable: boolean;
}): JSX.Element {
  const shots = detail.steps.filter((s) => s.key.startsWith("shot-"));
  return (
    <section>
      <h2>Storyboard and shot previews</h2>
      {!shots.length && <p>Shot planning has not completed.</p>}
      {shots.map((step) => {
        const shot = ShotSpecSchema.safeParse(step.input);
        const media = detail.artifactUrls.find((a) => a.stepId === step.id)?.artifacts ?? [];
        return (
          <article key={step.id}>
            <h3>
              {step.key} · attempt {step.attempt}
            </h3>
            <p>
              {step.state} · {dollars(step.costMinor ?? 0)}
            </p>
            {shot.success && (
              <>
                <p>{shot.data.keyframePrompt}</p>
                <p>{shot.data.motionPrompt}</p>
                <p>{shot.data.voLine}</p>
              </>
            )}
            <ShotMedia media={media} />
            {editable && detail.run.state === "CRITIC" && shot.success && (
              <button
                className="rf-button rf-button--secondary"
                disabled={busy}
                onClick={() => reshoot(shot.data.ordinal)}
              >
                Reshoot this shot
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}
export function RunScreen({ id }: { id: string }): JSX.Element {
  const workspace = useActiveWorkspace();
  const { detail, error, connection, refresh } = useRun(workspace.id, id);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = workspace.role !== "VIEWER";
  const action = async (path: string): Promise<void> => {
    setBusy(true);
    setActionError("");
    try {
      await runRequest(`runs/${id}/${path}`, workspace.id, {});
      refresh();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!detail) return <p role={error ? "alert" : "status"}>{error || "Loading run…"}</p>;
  const stageWaiting =
    detail.steps.some((s) => s.state === "WAITING_APPROVAL") &&
    detail.run.effectiveAutonomy === "L1";
  return (
    <section>
      <h1>Short {id.slice(0, 8)}</h1>
      <p role="status">
        {connection} · {detail.run.state} · Cost so far {dollars(detail.envelope?.spentMinor ?? 0)}
      </p>
      {(error || actionError) && <p role="alert">{error || actionError}</p>}
      <RunSteps detail={detail} />
      {stageWaiting && editable && (
        <button className="rf-button" disabled={busy} onClick={() => void action("approve")}>
          Approve stage
        </button>
      )}
      <ApprovalPanel
        detail={detail}
        workspaceId={workspace.id}
        editable={editable}
        refresh={refresh}
      />
      <AutonomyPanel
        workspaceId={workspace.id}
        run={detail.run}
        editable={editable}
        refresh={refresh}
      />
      <Storyboard
        detail={detail}
        reshoot={(ordinal) => void action(`reshoot/${ordinal}`)}
        busy={busy}
        editable={editable}
      />
    </section>
  );
}

function RunSteps({ detail }: { detail: RunDetailView }): JSX.Element {
  return (
    <ol aria-label="Live run steps">
      {detail.steps.map((s) => (
        <li key={s.id}>
          {s.key} · {s.state} · attempt {s.attempt}
        </li>
      ))}
    </ol>
  );
}

function ShotMedia({
  media,
}: {
  media: RunDetailView["artifactUrls"][number]["artifacts"];
}): JSX.Element {
  return (
    <>
      {" "}
      {media.map((a) =>
        a.contentType === "video/mp4" ? (
          <video
            key={a.url}
            src={a.url}
            controls
            preload="metadata"
            style={{ maxWidth: "100%", maxHeight: 400 }}
          />
        ) : (
          <a key={a.url} href={a.url}>
            Open {a.kind}
          </a>
        ),
      )}
    </>
  );
}
