"use client";
import { useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { requestNavigationIntent } from "../../components/studio-navigation";
import { Alert, Badge, Button, Field, Panel, TextAreaField } from "../../components/ui/primitives";
import { canWrite, nextStatus, PlanningApiError, type Idea, type IdeaStatus } from "./model";
import { usePlanning, useLoad, message } from "./session";
import { IdeaForm } from "./idea-form";
import { Choice, json, LoadState, SafeReferences } from "./common";
import styles from "./planning.module.css";
export function IdeaWorkspace({ ideaId }: { ideaId: string }): JSX.Element {
  const { client, refresh, suspended } = usePlanning();
  const state = useLoad((c) => c.idea(ideaId), `idea:${ideaId}`);
  const approval = useLoad((c) => c.approvedIdea(ideaId), `approved:${ideaId}`);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const idea = state.data;
  const [conflict, setConflict] = useState<{ observed: Idea; latest: Idea | null } | null>(null);
  const [notice, setNotice] = useState("");
  const act = async (kind: IdeaStatus | "archive" | "restore"): Promise<void> => {
    if (
      !idea ||
      !canWrite(client.role) ||
      suspended ||
      busy ||
      Boolean(conflict) ||
      !requestNavigationIntent("selection")
    )
      return;
    if (
      !window.confirm(
        `${kind === "APPROVED" ? "Approve and capture an immutable snapshot of" : kind === "archive" ? "Archive" : kind === "restore" ? "Restore" : "Change status for"} this idea?`,
      )
    )
      return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (kind === "archive" || kind === "restore")
        await client.archiveIdea(idea, kind === "restore");
      else
        await client.transitionIdea(
          idea,
          kind,
          kind === "SCHEDULED" ? new Date(scheduledAt).toISOString() : undefined,
        );
      if (!client.signal.aborted) {
        setNotice("Idea action saved by the server.");
        refresh();
      }
    } catch (cause) {
      if (!client.signal.aborted) {
        setError(message(cause));
        if (cause instanceof PlanningApiError && cause.status === 409) {
          setConflict({ observed: idea, latest: null });
          try {
            const latest = await client.idea(idea.id);
            if (!client.signal.aborted) setConflict({ observed: idea, latest });
          } catch (readError) {
            if (!client.signal.aborted) setError(message(readError));
          }
        }
        refresh();
      }
    } finally {
      if (!client.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className={styles.workspace}>
      <StudioLink href="/planning">← Back to planning</StudioLink>
      <LoadState {...state} />
      {idea && (
        <>
          <header className={styles.header}>
            <div>
              <p className="rf-eyebrow">Idea brief</p>
              <h1>{idea.title}</h1>
              <Badge tone={idea.status === "APPROVED" ? "success" : "neutral"}>
                {idea.archivedAt ? `Archived · ${idea.status}` : idea.status}
              </Badge>
              <p className={styles.meta}>Saved {new Date(idea.updatedAt).toLocaleString()}</p>
            </div>
            <Button tone="secondary" onClick={refresh}>
              Refresh brief
            </Button>
          </header>
          {error && (
            <Alert tone="danger" title="Idea action failed">
              {error}
            </Alert>
          )}
          {notice && <p role="status">{notice}</p>}
          {conflict && (
            <Alert tone="warning" title="Compare idea before another action">
              <p>
                The action was rejected. Compare the idea you observed with the refreshed saved
                brief. No automatic retry was made.
              </p>
              <div className={styles.compare}>
                <pre className={styles.inspect}>{json(conflict.observed)}</pre>
                <pre className={styles.inspect}>
                  {conflict.latest
                    ? json(conflict.latest)
                    : "Latest saved brief unavailable. Refresh before continuing."}
                </pre>
              </div>
              <Button
                tone="secondary"
                onClick={() => {
                  void client
                    .idea(idea.id)
                    .then((latest) => {
                      if (!client.signal.aborted) {
                        setConflict({ ...conflict, latest });
                        refresh();
                      }
                    })
                    .catch((cause: unknown) => {
                      if (!client.signal.aborted) setError(message(cause));
                    });
                }}
              >
                Fetch latest for action comparison
              </Button>
              <Button
                disabled={
                  busy ||
                  state.loading ||
                  Boolean(state.error) ||
                  !conflict.latest ||
                  conflict.latest.updatedAt !== idea.updatedAt ||
                  conflict.latest.status !== idea.status
                }
                onClick={() => {
                  setConflict(null);
                  setError("");
                }}
              >
                Use refreshed brief for next action
              </Button>
            </Alert>
          )}
          <div className={styles.grid}>
            <IdeaForm
              key={idea.id}
              idea={idea}
              locked={
                approval.loading ||
                Boolean(approval.error) ||
                Boolean(approval.data) ||
                Boolean(idea.archivedAt) ||
                ["APPROVED", "SCHEDULED"].includes(idea.status)
              }
              onSaved={refresh}
            />
            <div className={styles.workspace}>
              <Panel>
                <h2>Brief references</h2>
                <p>{idea.sourceNotes || "No source notes saved."}</p>
                <SafeReferences items={idea.references} />
                {idea.duplicateMatches?.length ? (
                  <>
                    <h3>Server duplicate matches</h3>
                    <ul>
                      {idea.duplicateMatches.map((match, index) => (
                        <li key={index}>
                          {match.reason}
                          {match.matchedIdeaId && (
                            <>
                              {" "}
                              ·{" "}
                              <StudioLink href={`/planning/ideas/${match.matchedIdeaId}`}>
                                Inspect matching idea
                              </StudioLink>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </Panel>
              <Panel>
                <h2>Status & archive</h2>
                <p>
                  Archiving preserves the record and its status. An approval snapshot permanently
                  protects the original brief.
                </p>
                <LoadState {...approval} />
                {!idea.archivedAt && (
                  <div className={styles.actions}>
                    {nextStatus(idea.status).map((status) => (
                      <Button
                        key={status}
                        disabled={
                          !canWrite(client.role) ||
                          suspended ||
                          busy ||
                          Boolean(conflict) ||
                          (status === "SCHEDULED" && !scheduledAt)
                        }
                        onClick={() => void act(status)}
                      >
                        {status === "APPROVED"
                          ? "Approve idea"
                          : status === "SCHEDULED"
                            ? "Schedule idea"
                            : status === "BACKLOG"
                              ? "Move to backlog"
                              : "Reject idea"}
                      </Button>
                    ))}
                  </div>
                )}
                {idea.status === "APPROVED" && !idea.archivedAt && (
                  <Field
                    id="idea-scheduled-time"
                    label="Schedule for"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    disabled={!canWrite(client.role) || suspended}
                  />
                )}
                <Button
                  tone="secondary"
                  disabled={
                    !canWrite(client.role) ||
                    suspended ||
                    busy ||
                    Boolean(conflict) ||
                    approval.loading ||
                    Boolean(approval.error) ||
                    (!idea.archivedAt && Boolean(approval.data))
                  }
                  onClick={() => void act(idea.archivedAt ? "restore" : "archive")}
                >
                  {idea.archivedAt ? "Restore idea" : "Archive idea"}
                </Button>
              </Panel>
              {approval.data && (
                <Panel>
                  <h2>Immutable approval snapshot</h2>
                  <p className={styles.meta}>{approval.data.checksumSha256}</p>
                  <details>
                    <summary>Inspect persisted snapshot</summary>
                    <pre className={styles.inspect}>{json(approval.data)}</pre>
                  </details>
                </Panel>
              )}
              <GenerationPreparation
                ideaId={ideaId}
                approved={idea.status === "APPROVED" && !idea.archivedAt}
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function GenerationPreparation({
  ideaId,
  approved,
}: {
  ideaId: string;
  approved: boolean;
}): JSX.Element {
  const { client, suspended, refresh } = usePlanning();
  const snapshot = useLoad((c) => c.approvedIdea(ideaId), `generation-approval:${ideaId}`);
  const configs = useLoad((c) => c.objects("config/generation-snapshots"), "generation-configs");
  const bundles = useLoad((c) => c.objects("prompts/bundle-snapshots"), "generation-bundles");
  const [configId, setConfigId] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  const pairs = (bundles.data ?? []).filter((v) => v.configSnapshotId === configId);
  const generate = async (): Promise<void> => {
    if (
      !approved ||
      !snapshot.data ||
      !canWrite(client.role) ||
      suspended ||
      busy ||
      created ||
      !configId ||
      !bundleId ||
      !prompt.trim()
    )
      return;
    if (!window.confirm("Generate a script? This may incur provider charges.")) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.generateScript({
        approvedIdeaSnapshotId: snapshot.data.id,
        approvedIdeaChecksum: snapshot.data.checksumSha256,
        configSnapshotId: configId,
        promptSnapshotId: bundleId,
        prompt: prompt.trim(),
        ...(snapshot.data.channelId ? { channelId: snapshot.data.channelId } : {}),
      });
      if (!client.signal.aborted) setCreated(result.id);
    } catch (cause) {
      if (!client.signal.aborted) {
        setError(message(cause));
        refresh();
      }
    } finally {
      if (!client.signal.aborted) setBusy(false);
    }
  };
  return (
    <Panel>
      <h2>Prepare script generation</h2>
      <p>
        Generation needs the current approved idea checksum, an owned configuration/prompt snapshot
        pair and server-side budget preflight.
      </p>
      <LoadState {...snapshot} />
      <LoadState {...configs} />
      <LoadState {...bundles} />
      <div className={styles.form}>
        <Choice
          label="Generation configuration snapshot"
          items={configs.data ?? []}
          value={configId}
          onChange={(v) => {
            setConfigId(v);
            setBundleId("");
          }}
          disabled={!canWrite(client.role) || suspended}
        />
        <Choice
          label="Matching prompt bundle snapshot"
          items={pairs}
          value={bundleId}
          onChange={setBundleId}
          disabled={!canWrite(client.role) || suspended}
        />
        <TextAreaField
          id="script-generation-instructions"
          label="Additional generation instructions (not saved)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={!canWrite(client.role) || suspended || busy}
          maxLength={20000}
        />
      </div>
      {!approved && (
        <p className={styles.notice}>Approve the active idea before generating a script.</p>
      )}
      <p>
        Generation requires a configured provider and may incur charges. The server checks the
        budget before dispatch.
      </p>
      {error && (
        <Alert tone="danger" title="Script generation failed">
          {error}. Check the script library before making another request.
        </Alert>
      )}
      <Button
        disabled={
          !approved ||
          !snapshot.data ||
          !canWrite(client.role) ||
          suspended ||
          busy ||
          Boolean(created) ||
          !configId ||
          !bundleId ||
          !prompt.trim()
        }
        onClick={() => void generate()}
      >
        {busy ? "Generating…" : "Generate script"}
      </Button>
      {created && (
        <p role="status">
          Script created.{" "}
          <StudioLink href={`/planning/scripts/${encodeURIComponent(created)}`}>
            Open script
          </StudioLink>
        </p>
      )}
      {snapshot.data && configId && bundleId && (
        <p className={styles.meta}>
          Prepared references: approved snapshot {snapshot.data.id}; configuration {configId};
          prompt bundle {bundleId}.
        </p>
      )}
    </Panel>
  );
}
