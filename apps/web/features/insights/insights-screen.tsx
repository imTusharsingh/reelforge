"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Badge, Button, Panel, StateMessage } from "../../components/ui/primitives";

type Item = Record<string, unknown>;
type Option = { id: string; name: string; channelId?: string };
type Snapshot = Item & {
  id: string;
  key: string;
  value: number | null;
  remoteEntityId: string | null;
  completeness: string;
  availability: string;
  unavailableReason: string | null;
  periodStart: string;
  periodEnd: string;
  collectedAt: string;
  sourceApi: string;
};
type Report = Item & {
  id: string;
  status: string;
  aiStatus?: string;
  provider?: { status?: string } | null;
  dimensions?: Item[];
};
type Recommendation = Item & {
  id: string;
  rank?: number;
  action: string;
  rationale: string;
  confidence: string;
  limitations?: string[];
  evidenceSnapshotIds?: string[];
  status: string;
};
const isList = (value: unknown): value is Item[] =>
  Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null);
const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length ? value : fallback;
function dateDaysAgo(days: number): string {
  const value = new Date();
  value.setDate(value.getDate() - days);
  return value.toISOString().slice(0, 10);
}

export function InsightsScreen(): JSX.Element {
  const workspace = useActiveWorkspace();
  const [channels, setChannels] = useState<Option[]>([]);
  const [accounts, setAccounts] = useState<Option[]>([]);
  const [channelId, setChannelId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [startDate, setStartDate] = useState(dateDaysAgo(27));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [tab, setTab] = useState("Overview");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [labels, setLabels] = useState<Item[]>([]);
  const [status, setStatus] = useState(
    "Select a channel and YouTube account to load verified analytics.",
  );
  const [busy, setBusy] = useState(false);
  const canEdit = workspace.role === "OWNER" || workspace.role === "EDITOR";
  const base = `/api/v1/workspaces/${encodeURIComponent(workspace.id)}`;
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${base}/${path}`, { credentials: "include" });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? "You do not have access to this workspace."
          : "The selected analytics data is unavailable.",
      );
    return body;
  };
  const post = async (path: string, body: Item): Promise<unknown> => {
    const response = await fetch(`${base}/${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? "Owner or editor access is required for this action."
          : response.status === 409
            ? "This item is no longer proposed."
            : "The action could not be completed.",
      );
    return payload;
  };
  useEffect((): (() => void) => {
    let active = true;
    void Promise.all([get("channels"), get("social-accounts")])
      .then(([channelData, accountData]) => {
        if (!active) return;
        if (isList(channelData))
          setChannels(
            channelData
              .filter((x) => typeof x.id === "string")
              .map((x) => ({ id: String(x.id), name: text(x.name, String(x.id)) })),
          );
        if (isList(accountData))
          setAccounts(
            accountData
              .filter((x) => x.platform === "YOUTUBE" && typeof x.id === "string")
              .map((x) => {
                const account: Option = {
                  id: String(x.id),
                  name: text(x.displayName, text(x.handle, String(x.id))),
                };
                if (typeof x.channelId === "string") account.channelId = x.channelId;
                return account;
              }),
          );
      })
      .catch(() => {
        if (active) setStatus("Channels or verified YouTube accounts are unavailable.");
      });
    return () => {
      active = false;
    };
  }, [workspace.id]);
  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(channels[0].id);
  }, [channelId, channels]);
  useEffect(() => {
    const match = accounts.find((account) => account.channelId === channelId);
    if (match) setAccountId(match.id);
    else if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accountId, accounts, channelId]);
  async function load(granularity: "CHANNEL" | "VIDEO" = "CHANNEL"): Promise<void> {
    if (!channelId || !accountId) {
      setStatus("Select a channel and verified YouTube account first.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const query = new URLSearchParams({
        socialAccountId: accountId,
        startDate,
        endDate,
        granularity,
      });
      const [metricData, reportData, recommendationData, publishedData] = await Promise.all([
        get(`channels/${encodeURIComponent(channelId)}/metrics/snapshots?${query}`),
        get(`performance-intelligence/reports?channelId=${encodeURIComponent(channelId)}`),
        get(`performance-intelligence/recommendations?channelId=${encodeURIComponent(channelId)}`),
        get("publishing/published-records?limit=500"),
      ]);
      setSnapshots(isList(metricData) ? (metricData as Snapshot[]) : []);
      setReports(isList(reportData) ? (reportData as Report[]) : []);
      setRecommendations(
        isList(recommendationData) ? (recommendationData as Recommendation[]) : [],
      );
      setLabels(isList(publishedData) ? publishedData : []);
      if (!isList(metricData) || metricData.length === 0)
        setStatus("No verified snapshots exist in this window.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Analytics are unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function mutate(action: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      setStatus(success);
      await load(tab === "Videos" ? "VIDEO" : "CHANNEL");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }
  const latestReport = reports[0];
  const grouped = useMemo(
    () =>
      snapshots.reduce<Record<string, Snapshot[]>>((out, row) => {
        (out[row.remoteEntityId ?? "channel"] ??= []).push(row);
        return out;
      }, {}),
    [snapshots],
  );
  const metrics = snapshots.filter((row) => row.remoteEntityId === null).slice(0, 8);
  return (
    <div className="rf-insights" style={{ maxWidth: 1180 }}>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Insights</p>
        <h1>Make performance legible.</h1>
        <p>Verified metrics, evidence-linked comparisons, and explainable recommendations.</p>
      </header>
      <Panel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))",
            gap: 12,
          }}
        >
          <label>
            Channel
            <select
              aria-label="Channel"
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
            >
              <option value="">Select channel</option>
              {channels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            YouTube account
            <select
              aria-label="YouTube account"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">Select account</option>
              {accounts
                .filter((item) => !item.channelId || item.channelId === channelId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
            />
          </label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <Button onClick={() => void load()} disabled={busy}>
            Load verified metrics
          </Button>
          {canEdit && (
            <Button
              tone="secondary"
              onClick={() =>
                void mutate(
                  () =>
                    post("analytics/collection-jobs", {
                      channelId,
                      socialAccountId: accountId,
                      startDate,
                      endDate,
                    }),
                  "Collection queued.",
                )
              }
              disabled={busy}
            >
              Collect data
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
      {status && (
        <StateMessage
          kind={status.toLowerCase().includes("unavailable") ? "unavailable" : "empty"}
          description={`${status} Missing values remain unavailable; they are never shown as zero.`}
        />
      )}
      {!status && (
        <>
          <div className="rf-studio-grid">
            {metrics.map((row) => (
              <Panel key={row.id}>
                <p className="rf-eyebrow">{row.key}</p>
                <h2>{row.value === null ? "Unavailable" : row.value.toLocaleString()}</h2>
                <Badge
                  tone={
                    row.completeness === "COMPLETE" && row.availability === "AVAILABLE"
                      ? "success"
                      : "warning"
                  }
                >
                  {row.completeness === "PARTIAL"
                    ? "PARTIAL · delayed"
                    : row.availability === "UNAVAILABLE"
                      ? "UNAVAILABLE"
                      : row.completeness}
                </Badge>
                <p className="rf-muted">
                  {row.unavailableReason ?? "Verified snapshot"} · {row.periodStart}–{row.periodEnd}
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
                ? "Published-video performance and top content"
                : tab === "Comparisons"
                  ? "Comparisons"
                  : tab === "Recommendations"
                    ? "Recommendations"
                    : "Overview and trends"}
            </h2>
            {tab === "Videos" && (
              <div>
                {Object.entries(grouped)
                  .filter(([id]) => id !== "channel")
                  .map(([id, rows]) => (
                    <p key={id}>
                      <strong>
                        {text(
                          labels.find((label) => label.platformPostId === id)?.title,
                          `Published video ${id}`,
                        )}
                      </strong>{" "}
                      · {rows.filter((row) => row.value !== null).length} verified observations
                    </p>
                  ))}
              </div>
            )}
            {tab === "Comparisons" && (
              <>
                <p className="rf-muted">
                  M15 dimensions: topic, hook, duration, character, series, and publish timing.
                  Genre comparisons are not supported.
                </p>
                {latestReport?.status === "INSUFFICIENT_DATA" && (
                  <StateMessage
                    kind="empty"
                    description="Insufficient sample size for a confident comparison."
                  />
                )}
                {latestReport?.dimensions?.map((dimension, index) => (
                  <p key={index}>
                    <Badge>{text(dimension.dimension, "Dimension")}</Badge>{" "}
                    {text(dimension.status, "INSUFFICIENT_DATA")}
                  </p>
                ))}
              </>
            )}
            {tab === "Recommendations" && (
              <>
                <p className="rf-muted">
                  AI status:{" "}
                  {text(latestReport?.aiStatus ?? latestReport?.provider?.status, "NOT_CONFIGURED")}
                  . Deterministic KPIs remain available.
                </p>
                {canEdit && latestReport && (
                  <Button
                    onClick={() =>
                      void mutate(
                        () =>
                          post(
                            `performance-intelligence/reports/${latestReport.id}/recommendations`,
                            { reportId: latestReport.id },
                          ),
                        "Recommendations generated.",
                      )
                    }
                    disabled={busy}
                  >
                    Generate recommendations
                  </Button>
                )}
                {recommendations.map((recommendation) => (
                  <Panel key={recommendation.id}>
                    <h3>
                      #{recommendation.rank ?? "—"} {recommendation.action}
                    </h3>
                    <p>{recommendation.rationale}</p>
                    <p>
                      Confidence: {recommendation.confidence} · Status: {recommendation.status}
                    </p>
                    <p>Limitations: {recommendation.limitations?.join("; ") ?? "None recorded"}</p>
                    <p>
                      Evidence snapshots: {recommendation.evidenceSnapshotIds?.join(", ") ?? "None"}
                    </p>
                    {canEdit && recommendation.status === "PROPOSED" && (
                      <Button
                        onClick={() =>
                          void mutate(
                            () =>
                              post(
                                `performance-intelligence/recommendations/${recommendation.id}/approve`,
                                {},
                              ),
                            "Recommendation approved.",
                          )
                        }
                        disabled={busy}
                      >
                        Approve
                      </Button>
                    )}
                  </Panel>
                ))}
              </>
            )}
          </Panel>
        </>
      )}
      {canEdit && (
        <Button
          onClick={() =>
            void mutate(
              () =>
                post("performance-intelligence/reports", {
                  channelId,
                  socialAccountId: accountId,
                  startDate,
                  endDate,
                }),
              "Report generated.",
            )
          }
          disabled={busy}
        >
          Generate report
        </Button>
      )}
    </div>
  );
}
