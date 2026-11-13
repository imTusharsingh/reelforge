"use client";

import { useEffect, useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge, Panel } from "../../components/ui/primitives";
import type { PublishedRecord } from "./model";
import { usePublishingClient } from "./session";

export function History(): JSX.Element {
  const api = usePublishingClient();
  const [items, setItems] = useState<PublishedRecord[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void api
      .history()
      .then((records) => {
        if (active) setItems(records);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Publishing history could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [api]);

  return (
    <section>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Publishing</p>
        <h1>Delivery history</h1>
        <p>Each entry is a platform delivery confirmed by the publishing service.</p>
        <div className="rf-action-row">
          <StudioLink href="/publishing">Calendar</StudioLink>
          <StudioLink href="/publishing/accounts">Social accounts</StudioLink>
        </div>
      </header>
      {error && (
        <Alert tone="danger" title="History unavailable">
          {error}
        </Alert>
      )}
      <Panel>
        {loading ? (
          <p role="status">Loading delivery history…</p>
        ) : items.length === 0 ? (
          <p>No published deliveries yet.</p>
        ) : (
          <ul className="rf-history-list">
            {items.map((item) => (
              <li key={item.destinationId} className="rf-history-row">
                <p>
                  <Badge tone="success">{item.platform}</Badge>{" "}
                  {new Date(item.publishedAt).toLocaleString()}
                </p>
                <p className="rf-account-id">Platform post ID: {item.platformPostId}</p>
                <StudioLink
                  href={`/publishing/posts/${encodeURIComponent(item.scheduledPostId)}`}
                >
                  Post details
                </StudioLink>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}
