"use client";

import { useCallback, useEffect, useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Alert, Badge, Button, Field, Panel } from "../../components/ui/primitives";
import {
  browserTimeZone,
  describeGates,
  isEditableRole,
  type Post,
  type Preflight,
} from "./model";
import { usePublishingClient } from "./session";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

function statusTone(status: string): Tone {
  if (status === "PUBLISHED") return "success";
  if (["FAILED_RETRYABLE", "FAILED_FINAL", "RECONCILIATION_REQUIRED"].includes(status))
    return "danger";
  if (["SCHEDULED", "REMOTE_PROCESSING"].includes(status)) return "info";
  if (status === "CANCELED") return "warning";
  return "neutral";
}

export function PostDetail({ postId }: { postId: string }): JSX.Element {
  const workspace = useActiveWorkspace();
  const editable = isEditableRole(workspace.role);
  const api = usePublishingClient();
  const scope = `post:${postId}`;
  const timezone = browserTimeZone();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [reconciled, setReconciled] = useState(false);
  const [preflights, setPreflights] = useState<Record<string, Preflight>>({});
  const [time, setTime] = useState("");

  useEffect(() => {
    let active = true;
    setPending(api.pending(scope));
    void api.post(postId).then(
      (value) => {
        if (!active) return;
        setPost(value);
        if (value.scheduledAt !== null) {
          const date = new Date(value.scheduledAt);
          const offset = date.getTimezoneOffset() * 60_000;
          setTime(new Date(date.getTime() - offset).toISOString().slice(0, 16));
        }
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Post unavailable.");
      },
    );
    return (): void => {
      active = false;
    };
  }, [api, postId, scope]);

  const write = useCallback(
    async (operation: () => Promise<Post>): Promise<void> => {
      if (!editable || busy || pending) return;
      setBusy(true);
      setError("");
      try {
        const next = await operation();
        setPost(next);
        setPending(api.pending(scope));
        setReconciled(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The action could not be completed.");
        setPending(api.pending(scope));
        setReconciled(false);
      } finally {
        setBusy(false);
      }
    },
    [api, busy, editable, pending, scope],
  );

  const refresh = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const next = await api.reconcilePost(postId);
      setPost(next);
      setReconciled(true);
      setPending(api.pending(scope));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Post unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const acknowledge = (): void => {
    try {
      api.acknowledge(scope);
      setPending(false);
      setReconciled(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recovery state could not be cleared.");
    }
  };

  const check = async (destinationId: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const result = await api.preflight(destinationId);
      setPreflights((current) => ({ ...current, [destinationId]: result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preflight could not be loaded.");
    } finally {
      setBusy(false);
    }
  };

  const editableBeforePublish =
    post !== null &&
    post.destinations.length > 0 &&
    post.destinations.every(
      (destination) =>
        ["DRAFT", "SCHEDULED"].includes(destination.status) && destination.latestAttempt === null,
    );

  return (
    <section>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Publishing</p>
        <h1>Post detail</h1>
        <div className="rf-action-row">
          <StudioLink href="/publishing">Calendar</StudioLink>
          <StudioLink href="/publishing/history">Delivery history</StudioLink>
          {post && (
            <StudioLink href={`/production/renders/${encodeURIComponent(post.renderJobId)}`}>
              Render workflow
            </StudioLink>
          )}
        </div>
      </header>
      {error && (
        <Alert tone="danger" title="Request failed">
          {error}
        </Alert>
      )}
      {pending && (
        <Alert tone="warning" title="Previous action may still be pending">
          Refresh and inspect the persisted state before acknowledging it. Do not repeat the action
          until it is reconciled.
          <div className="rf-action-row">
            <Button tone="secondary" disabled={busy} onClick={() => void refresh()}>
              Refresh post
            </Button>
            <Button tone="secondary" disabled={busy || !reconciled} onClick={acknowledge}>
              I inspected the saved state
            </Button>
          </div>
        </Alert>
      )}
      {!post ? (
        <p role="status">Loading post…</p>
      ) : (
        <>
          <Panel>
            <h2>
              <Badge tone={statusTone(post.status)}>{post.status}</Badge>{" "}
              {post.scheduledAt
                ? new Date(post.scheduledAt).toLocaleString()
                : "Unscheduled draft"}
            </h2>
            <p>
              Times shown in {timezone}. Revision {post.revision}.
            </p>
            <p>
              Disclosure: {post.disclosureDecision}
              {post.disclosureText ? ` — ${post.disclosureText}` : ""} · {post.disclosureReason}
            </p>
            <p>
              Quality review{" "}
              <StudioLink
                href={`/review/runs/${encodeURIComponent(post.qualityReviewRunId)}`}
              >
                {post.qualityReviewRunId}
              </StudioLink>
            </p>
            {editable && editableBeforePublish && (
              <>
                <Field
                  id="reschedule"
                  label={`Reschedule (${timezone})`}
                  type="datetime-local"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
                <div className="rf-action-row">
                  <Button
                    disabled={busy || pending || !time}
                    onClick={() => {
                      const date = new Date(time);
                      if (Number.isFinite(date.getTime()))
                        void write(() => api.reschedule(postId, date.toISOString()));
                    }}
                  >
                    Reschedule
                  </Button>
                  <Button
                    tone="secondary"
                    disabled={busy || pending || post.scheduledAt === null}
                    onClick={() => void write(() => api.reschedule(postId, null))}
                  >
                    Move to draft
                  </Button>
                  <Button
                    tone="danger"
                    disabled={busy || pending}
                    onClick={() => {
                      if (window.confirm("Cancel this post?"))
                        void write(() => api.cancel(postId));
                    }}
                  >
                    Cancel post
                  </Button>
                </div>
              </>
            )}
            {editable && !editableBeforePublish && (
              <p>A publish attempt exists, so metadata and schedule are immutable.</p>
            )}
          </Panel>
          {post.destinations.map((destination) => {
            const checkResult = preflights[destination.id];
            const canPublish =
              checkResult !== undefined ? checkResult.canPublish : false;
            return (
              <Panel key={destination.id}>
                <h2>
                  {destination.platform} ·{" "}
                  <Badge tone={statusTone(destination.status)}>{destination.status}</Badge>
                </h2>
                {destination.remotePostId && <p>Platform post ID: {destination.remotePostId}</p>}
                {destination.publishedAt && (
                  <p>Published {new Date(destination.publishedAt).toLocaleString()}</p>
                )}
                {destination.lastErrorMessage && (
                  <p>
                    {destination.lastErrorCode ? `${destination.lastErrorCode}: ` : ""}
                    {destination.lastErrorMessage}
                  </p>
                )}
                {destination.latestAttempt && (
                  <p>
                    Attempt {destination.latestAttempt.attemptNumber} ·{" "}
                    {destination.latestAttempt.status}
                    {destination.latestAttempt.errorMessage
                      ? ` — ${destination.latestAttempt.errorMessage}`
                      : ""}
                  </p>
                )}
                <div className="rf-action-row">
                  <Button
                    tone="secondary"
                    disabled={busy}
                    onClick={() => void check(destination.id)}
                  >
                    Check preflight
                  </Button>
                  {editable &&
                    ["DRAFT", "SCHEDULED"].includes(destination.status) &&
                    destination.latestAttempt === null && (
                      <Button
                        disabled={busy || pending || !canPublish}
                        onClick={() => void write(() => api.publishNow(postId, destination.id))}
                      >
                        Publish now
                      </Button>
                    )}
                  {editable && destination.status === "FAILED_RETRYABLE" && (
                    <Button
                      disabled={busy || pending}
                      onClick={() => void write(() => api.retry(postId, destination.id))}
                    >
                      Retry
                    </Button>
                  )}
                  {editable &&
                    ["RECONCILIATION_REQUIRED", "REMOTE_PROCESSING"].includes(
                      destination.status,
                    ) && (
                      <Button
                        disabled={busy || pending}
                        onClick={() =>
                          void write(() => api.reconcileDestination(postId, destination.id))
                        }
                      >
                        Reconcile
                      </Button>
                    )}
                </div>
                {checkResult && (
                  <ul>
                    {describeGates(checkResult.gates).map((line, index) => (
                      <li key={`${destination.id}-gate-${index}`}>{line}</li>
                    ))}
                  </ul>
                )}
              </Panel>
            );
          })}
        </>
      )}
    </section>
  );
}
