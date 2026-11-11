"use client";

import { useCallback, useEffect, useState, type JSX } from "react";
import { Alert, Badge, Button, Panel, StateMessage } from "../../components/ui/primitives";
import {
  loadM29Data,
  markAllNotificationsRead,
  markNotificationRead,
  runAction,
  type M29Context,
} from "./api";
import type { M29Data, WorkflowRun } from "./types";
import styles from "./m29.module.css";

const currency = (minor: number, code: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(minor / 100);

function redacted(message: string | null): string {
  if (!message) return "No additional detail was provided.";
  return message
    .replace(
      /(bearer\s+|api[_-]?key|token|secret|password|authorization)[^\s,;]*/gi,
      "$1[redacted]",
    )
    .slice(0, 240);
}

function safeActions(run: WorkflowRun): readonly ("cancel" | "retry" | "resume")[] {
  if (run.state === "RUNNING" || run.state === "WAITING") return ["cancel"];
  if (run.state === "FAILED") return ["retry"];
  if (run.state === "PAUSED") return ["resume", "cancel"];
  return [];
}

function RunCard({
  context,
  run,
  onChanged,
}: {
  context: M29Context;
  run: WorkflowRun;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const act = async (action: "cancel" | "retry" | "resume"): Promise<void> => {
    if (!window.confirm(`${action[0]?.toUpperCase()}${action.slice(1)} this workflow?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await runAction(context, run.id, action);
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={styles.row}>
      <div>
        <strong>{run.currentStepKey ?? "Workflow"}</strong>
        <small>
          {run.state} · updated {new Date(run.updatedAt).toLocaleString()}
        </small>
        {run.lastErrorMessage && (
          <p className={styles.error} role="alert">
            <strong>{run.lastErrorCode ?? "Workflow failed"}</strong>
            <br />
            {redacted(run.lastErrorMessage)}
          </p>
        )}
        {run.nextAction && <p className={styles.muted}>Next: {run.nextAction}</p>}
        <div className={styles.actions}>
          {safeActions(run).map((action) => (
            <Button
              key={action}
              tone={action === "cancel" ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => void act(action)}
            >
              {busy ? "Working…" : action}
            </Button>
          ))}
        </div>
        {message && (
          <p role="alert" className={styles.error}>
            {message}
          </p>
        )}
      </div>
      <Badge
        tone={run.state === "SUCCEEDED" ? "success" : run.state === "FAILED" ? "danger" : "info"}
      >
        {run.state}
      </Badge>
    </li>
  );
}

export function M29Dashboard({ context }: { context: M29Context }): JSX.Element {
  const [data, setData] = useState<M29Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    void loadM29Data(context)
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "M29 data could not be loaded."),
      )
      .finally(() => setLoading(false));
  }, [context]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (loading)
    return (
      <StateMessage kind="loading" description="Loading workflow, notification, and usage data…" />
    );
  if (error)
    return (
      <StateMessage
        kind="error"
        description={error}
        action={
          <Button tone="secondary" onClick={refresh}>
            Try again
          </Button>
        }
      />
    );
  if (!data)
    return (
      <StateMessage
        kind="unavailable"
        description="M29 needs an authenticated workspace context from M22."
      />
    );
  const budget = data.budgets
    .flatMap((item) => item.periods)
    .find((period) => period.period === "MONTH");
  const used =
    budget && budget.limitMinor > 0
      ? Math.min(100, (budget.consumedMinor / budget.limitMinor) * 100)
      : 0;
  return (
    <main className={styles.dashboard} aria-labelledby="m29-title">
      <header className={styles.heading}>
        <div>
          <p className="rf-eyebrow">Operations / M29</p>
          <h1 id="m29-title">Workflow control room</h1>
          <p className={styles.muted}>
            Monitor durable runs, notifications, and usage consumption.
          </p>
        </div>
        <Button tone="secondary" onClick={refresh}>
          Refresh
        </Button>
      </header>
      <div className={styles.grid}>
        <Panel className={styles.panel}>
          <h2>Workflow runs</h2>
          <p className={styles.muted}>Actions are confirmed by the backend state machine.</p>
          <ul className={styles.list}>
            {data.runs.length ? (
              data.runs.map((run) => (
                <RunCard key={run.id} context={context} run={run} onChanged={refresh} />
              ))
            ) : (
              <StateMessage kind="empty" description="No workflow runs have been recorded." />
            )}
          </ul>
        </Panel>
        <Panel className={styles.panel}>
          <h2>
            Notifications <Badge tone="info">{data.notifications.unreadCount} unread</Badge>
          </h2>
          <div className={styles.actions}>
            <Button
              tone="secondary"
              disabled={!data.notifications.unreadCount}
              onClick={() => void markAllNotificationsRead(context).then(refresh)}
            >
              Mark all read
            </Button>
          </div>
          <ul className={styles.list}>
            {data.notifications.items.length ? (
              data.notifications.items.map((notification) => (
                <li className={styles.row} key={notification.id}>
                  <div>
                    <strong>{notification.title}</strong>
                    <p>{notification.body}</p>
                    <small>{new Date(notification.createdAt).toLocaleString()}</small>
                  </div>
                  {!notification.readAt && (
                    <Button
                      tone="ghost"
                      onClick={() =>
                        void markNotificationRead(context, notification.id).then(refresh)
                      }
                    >
                      Mark read
                    </Button>
                  )}
                </li>
              ))
            ) : (
              <StateMessage kind="empty" description="You are all caught up." />
            )}
          </ul>
        </Panel>
        <Panel className={`${styles.panel} ${styles.wide}`}>
          <h2>Usage and budget</h2>
          <p className={styles.muted}>
            Consumption and budget accounting only — this is not subscription billing or an invoice.
          </p>
          <div className={styles.details}>
            <div>
              <span>Recorded usage</span>
              <strong>{currency(data.usage.totalMinor, data.usage.currency)}</strong>
            </div>
            <div>
              <span>Actual / estimated</span>
              <strong>
                {currency(data.usage.actualMinor, data.usage.currency)} /{" "}
                {currency(data.usage.estimatedMinor, data.usage.currency)}
              </strong>
            </div>
            {budget && (
              <div>
                <span>Monthly budget</span>
                <strong>
                  {currency(budget.consumedMinor, data.usage.currency)} /{" "}
                  {currency(budget.limitMinor, data.usage.currency)}
                </strong>
              </div>
            )}
          </div>
          {budget && (
            <>
              <div
                className={styles.meter}
                aria-label={`${Math.round(used)} percent of monthly budget consumed`}
              >
                <span style={{ width: `${used}%` }} />
              </div>
              <small className={styles.muted}>
                {budget.exhausted
                  ? "Budget exhausted; paid work is blocked."
                  : `${currency(budget.remainingMinor, data.usage.currency)} remaining`}
              </small>
            </>
          )}
        </Panel>
      </div>
      {context.role !== "OWNER" && (
        <Alert tone="info" title="Budget settings are owner-only">
          You can view usage and budget status. Only workspace owners can change caps or record
          adjustments.
        </Alert>
      )}
    </main>
  );
}
