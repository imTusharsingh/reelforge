"use client";

import { useCallback, useEffect, useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge, Button, Panel } from "../../components/ui/primitives";
import type { Post } from "./model";
import { usePublishingClient } from "./session";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

function statusTone(status: string): Tone {
  if (["PUBLISHED", "SCHEDULED"].includes(status)) return status === "PUBLISHED" ? "success" : "info";
  if (["FAILED_RETRYABLE", "FAILED_FINAL", "RECONCILIATION_REQUIRED"].includes(status))
    return "danger";
  if (["REMOTE_PROCESSING", "CANCELED"].includes(status)) return "warning";
  return "neutral";
}

function range(date: Date, mode: "month" | "week"): [Date, Date] {
  if (mode === "month")
    return [
      new Date(date.getFullYear(), date.getMonth(), 1),
      new Date(date.getFullYear(), date.getMonth() + 1, 1),
    ];
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
  return [start, new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)];
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function groupByDay(posts: Post[]): { key: string; label: string; posts: Post[] }[] {
  const groups: { key: string; label: string; posts: Post[] }[] = [];
  for (const post of posts) {
    if (post.scheduledAt === null) continue;
    const key = dayKey(post.scheduledAt);
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.posts.push(post);
    else groups.push({ key, label: dayLabel(post.scheduledAt), posts: [post] });
  }
  return groups;
}

export function Calendar(): JSX.Element {
  const api = usePublishingClient();
  const [date, setDate] = useState(() => new Date());
  const [mode, setMode] = useState<"month" | "week">("month");
  const [posts, setPosts] = useState<Post[]>([]);
  const [drafts, setDrafts] = useState<Post[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [start, end] = range(date, mode);
  const from = start.toISOString();
  const to = end.toISOString();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";

  const load = useCallback(
    async (signal: AbortSignal): Promise<void> => {
      const [calendar, draftPage] = await Promise.all([
        api.calendar(from, to),
        api.drafts(),
      ]);
      if (signal.aborted) return;
      setPosts(calendar);
      setDrafts(draftPage.items);
    },
    [api, from, to],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void load(controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Calendar could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return (): void => controller.abort();
  }, [load]);

  const move = (amount: number): void =>
    setDate((value) =>
      mode === "month"
        ? new Date(value.getFullYear(), value.getMonth() + amount, 1)
        : new Date(value.getFullYear(), value.getMonth(), value.getDate() + amount * 7),
    );
  const groups = groupByDay(posts);

  return (
    <section>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Publishing</p>
        <h1>Publishing calendar</h1>
        <p>Times shown in {timezone}. Scheduled and delivered state comes from the publishing service.</p>
        <div className="rf-action-row">
          <StudioLink href="/publishing/new">New post</StudioLink>
          <StudioLink href="/publishing/accounts">Manage social accounts</StudioLink>
          <StudioLink href="/publishing/history">Delivery history</StudioLink>
        </div>
      </header>
      {error && (
        <Alert tone="danger" title="Calendar unavailable">
          {error}
        </Alert>
      )}
      <Panel>
        <div className="rf-filter-row">
          <Button tone="secondary" onClick={() => move(-1)}>
            Previous
          </Button>
          <Button tone="secondary" onClick={() => setDate(new Date())}>
            Today
          </Button>
          <Button tone="secondary" onClick={() => move(1)}>
            Next
          </Button>
          <Button tone="secondary" aria-pressed={mode === "month"} onClick={() => setMode("month")}>
            Month
          </Button>
          <Button tone="secondary" aria-pressed={mode === "week"} onClick={() => setMode("week")}>
            Week
          </Button>
        </div>
        <h2>
          {start.toLocaleDateString(undefined, { dateStyle: "medium" })} –{" "}
          {new Date(end.getTime() - 1).toLocaleDateString(undefined, { dateStyle: "medium" })}
        </h2>
        {loading ? (
          <p role="status">Loading scheduled posts…</p>
        ) : groups.length === 0 ? (
          <p>No scheduled posts in this period.</p>
        ) : (
          <ol className="rf-calendar-days">
            {groups.map((group) => (
              <li key={group.key} className="rf-calendar-day">
                <h3>{group.label}</h3>
                <ul>
                  {group.posts.map((post) => (
                    <li key={post.id} className="rf-calendar-post">
                      <p>
                        <strong>
                          {post.scheduledAt
                            ? new Date(post.scheduledAt).toLocaleTimeString(undefined, {
                                hour: "numeric",
                                minute: "2-digit",
                              })
                            : "Unscheduled"}
                        </strong>{" "}
                        <Badge tone={statusTone(post.status)}>{post.status}</Badge>
                      </p>
                      <p>
                        {post.destinations.map((destination) => (
                          <span key={destination.id} className="rf-calendar-destination">
                            {destination.platform}: {destination.status}
                            {destination.lastErrorMessage ? ` — ${destination.lastErrorMessage}` : ""}
                          </span>
                        ))}
                      </p>
                      <StudioLink href={`/publishing/posts/${encodeURIComponent(post.id)}`}>
                        Inspect post
                      </StudioLink>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <Panel>
        <h2>Unscheduled drafts</h2>
        {loading ? (
          <p>Loading drafts…</p>
        ) : drafts.length === 0 ? (
          <p>No unscheduled drafts.</p>
        ) : (
          <ul>
            {drafts.map((draft) => (
              <li key={draft.id}>
                <StudioLink href={`/publishing/posts/${encodeURIComponent(draft.id)}`}>
                  Draft created {new Date(draft.createdAt).toLocaleString()}
                </StudioLink>{" "}
                · {draft.destinations.length} destination
                {draft.destinations.length === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}
