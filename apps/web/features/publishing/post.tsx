"use client";

import { useEffect, useState, type JSX } from "react";
import { usePublishingClient } from "./session";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge, Panel } from "../../components/ui/primitives";
import { browserTimeZone, type Post } from "./model";

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
  const api = usePublishingClient();
  const timezone = browserTimeZone();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.post(postId).then(
      (value) => {
        if (!active) return;
        setPost(value);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Post unavailable.");
      },
    );
    return (): void => {
      active = false;
    };
  }, [api, postId]);

  return (
    <section>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Publishing</p>
        <h1>Post detail</h1>
        <div className="rf-action-row">
          <StudioLink href="/publishing">Calendar</StudioLink>
          <StudioLink href="/publishing/history">Delivery history</StudioLink>
        </div>
      </header>
      {error && (
        <Alert tone="danger" title="Request failed">
          {error}
        </Alert>
      )}
      {!post ? (
        <p role="status">Loading post…</p>
      ) : (
        <>
          <Panel>
            <h2>
              <Badge tone={statusTone(post.status)}>{post.status}</Badge>{" "}
              {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "Unscheduled draft"}
            </h2>
            <p>
              Times shown in {timezone}. Revision {post.revision}.
            </p>
            <p>
              Disclosure: {post.disclosureDecision}
              {post.disclosureText ? ` — ${post.disclosureText}` : ""} · {post.disclosureReason}
            </p>
          </Panel>
          {post.destinations.map((destination) => {
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
              </Panel>
            );
          })}
        </>
      )}
    </section>
  );
}
