"use client";

import { useMemo, useState, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Badge, Button, Panel, StateMessage } from "../../components/ui/primitives";

type Snapshot = {
  id: string;
  key: string;
  value: number | null;
  unit: string;
  remoteEntityId: string | null;
  periodStart: string;
  periodEnd: string;
  collectedAt: string;
  sourceApi: string;
  completeness: string;
  availability: string;
  unavailableReason: string | null;
};

function dateDaysAgo(days: number): string {
  const value = new Date();
  value.setDate(value.getDate() - days);
  return value.toISOString().slice(0, 10);
}
function statusText(row: Snapshot): string {
  if (row.availability !== "AVAILABLE") return row.unavailableReason ?? "Metric unavailable";
  if (row.completeness !== "COMPLETE") return "Delayed or partial data";
  return "Verified snapshot";
}

export function InsightsScreen(): JSX.Element {
  const workspace = useActiveWorkspace();
  const [channelId, setChannelId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [startDate, setStartDate] = useState(dateDaysAgo(27));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [tab, setTab] = useState("Overview");
  const [rows, setRows] = useState<Snapshot[]>([]);
  const [message, setMessage] = useState(
    "Select a channel and YouTube account to load verified analytics.",
  );
  const [busy, setBusy] = useState(false);
  const canEdit = workspace.role === "OWNER" || workspace.role === "EDITOR";
  const grouped = useMemo(
    () =>
      rows.reduce<Record<string, Snapshot[]>>((result, row) => {
        (result[row.remoteEntityId ?? "channel"] ??= []).push(row);
        return result;
      }, {}),
    [rows],
  );

  async function load(granularity: "CHANNEL" | "VIDEO" = "CHANNEL"): Promise<void> {
    if (!channelId || !accountId) {
      setMessage("Channel and YouTube account IDs are required.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const query = new URLSearchParams({
        socialAccountId: accountId,
        startDate,
        endDate,
        granularity,
      });
      const response = await fetch(
        `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/channels/${encodeURIComponent(channelId)}/metrics/snapshots?${query}`,
        { credentials: "include" },
      );
      const payload: unknown = await response.json();
      if (!response.ok || !Array.isArray(payload))
        throw new Error(
          response.status === 403
            ? "You do not have access to this workspace."
            : "Analytics are unavailable for this selection.",
        );
      setRows(payload as Snapshot[]);
      setMessage(payload.length ? "" : "No verified snapshots exist in this window.");
    } catch (error) {
      setRows([]);
      setMessage(error instanceof Error ? error.message : "Analytics are unavailable.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rf-insights" style={{ maxWidth: 1180 }}>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Insights</p>
        <h1>Make performance legible.</h1>
        <p>
          Verified YouTube metrics, evidence-linked comparisons, and explainable recommendations.
        </p>
      </header>
      <Panel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
            gap: 12,
          }}
        >
          <label>
            Channel ID
            <input
              aria-label="Channel ID"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            />
          </label>
          <label>
            YouTube account ID
            <input
              aria-label="YouTube account ID"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>
          <label>
            From
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <Button onClick={() => void load()} disabled={busy}>
            {busy ? "Loading…" : "Load verified metrics"}
          </Button>
          {canEdit && (
            <Button tone="secondary" disabled>
              Collect data (available from channel controls)
            </Button>
          )}
        </div>
      </Panel>
      <nav
        aria-label="Insights views"
        style={{ display: "flex", gap: 8, margin: "20px 0", flexWrap: "wrap" }}
      >
        {["Overview", "Videos", "Comparisons", "Recommendations"].map((item) => (
          <Button
            key={item}
            tone={tab === item ? "primary" : "secondary"}
            onClick={() => {
              setTab(item);
              if (item === "Videos") void load("VIDEO");
            }}
          >
            {item}
          </Button>
        ))}
      </nav>
      {message && (
        <StateMessage
          kind={message.includes("unavailable") ? "unavailable" : "empty"}
          description={`${message} Missing values remain unavailable; they are never shown as zero.`}
        />
      )}
      {!message && (
        <>
          <div className="rf-studio-grid">
            {rows
              .filter((r) => r.remoteEntityId === null)
              .slice(0, 8)
              .map((row) => (
                <Panel key={row.id}>
                  <p className="rf-eyebrow">{row.key}</p>
                  <h2>
                    {row.value === null ? "Unavailable" : row.value.toLocaleString()}{" "}
                    {row.unit === "COUNT" ? "" : row.unit.toLowerCase()}
                  </h2>
                  <Badge tone={row.completeness === "COMPLETE" ? "success" : "warning"}>
                    {row.completeness}
                  </Badge>
                  <p className="rf-muted">
                    {statusText(row)} · {row.periodStart}–{row.periodEnd}
                  </p>
                  <small>
                    Source: {row.sourceApi} · Collected {new Date(row.collectedAt).toLocaleString()}
                  </small>
                </Panel>
              ))}
          </div>
          <Panel>
            <h2>
              {tab === "Videos"
                ? "Published-video performance"
                : tab === "Comparisons"
                  ? "Supported comparisons"
                  : tab === "Recommendations"
                    ? "Explainable recommendations"
                    : "Trends and top content"}
            </h2>
            <p className="rf-muted">
              {tab === "Comparisons"
                ? "Topic, hook, duration, character, series, and publish timing are supported. Genre comparisons are not supported."
                : tab === "Recommendations"
                  ? "Recommendations appear after an M15 report is generated. AI status remains NOT_CONFIGURED when no provider is configured."
                  : `${Object.keys(grouped).length} verified entities in the selected window.`}
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
