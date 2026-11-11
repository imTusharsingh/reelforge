"use client";

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Alert, Badge, Button, Field, Panel, StateMessage } from "../../components/ui/primitives";
import {
  loadM29Data,
  markAllNotificationsRead,
  markNotificationRead,
  runAction,
  saveBudget,
  savePreferences,
  type M29Context,
} from "./api";
import type { M29Data, NotificationPreference, WorkflowRun } from "./types";
import { redacted, safeActions } from "./logic";
import styles from "./m29.module.css";

export const currency = (minor: number, code: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(minor / 100);

function RunCard({
  context,
  run,
  onChanged,
  isCurrent,
}: {
  context: M29Context;
  run: WorkflowRun;
  onChanged: () => void;
  isCurrent: () => boolean;
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
      if (!isCurrent()) return;
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
        <details className={styles.details}>
          <summary>Steps, jobs and events</summary>
          {run.steps.map((step) => (
            <div key={step.id}>
              <span>
                {step.stepKey} · {step.status}
              </span>
              <small>
                {step.attempts}/{step.maxAttempts} attempts
              </small>
            </div>
          ))}
          <h3>Jobs</h3>
          {run.jobs.length ? (
            run.jobs.map((job) => (
              <div key={job.id}>
                <span>
                  {job.id} · {job.status}
                </span>
                <small>
                  attempt {job.attempt}
                  {job.errorCode ? ` · ${job.errorCode}` : ""}
                </small>
              </div>
            ))
          ) : (
            <small>No jobs recorded.</small>
          )}
          <h3>Events</h3>
          {run.events.length ? (
            run.events.map((event) => (
              <div key={event.id}>
                <span>{event.eventType}</span>
                <small>{new Date(event.occurredAt).toLocaleString()}</small>
              </div>
            ))
          ) : (
            <small>No events recorded.</small>
          )}
        </details>
        <div className={styles.actions}>
          {safeActions(run, context.role).map((action) => (
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

function Preferences({
  context,
  initial,
  onError,
  isCurrent,
}: {
  context: M29Context;
  initial: readonly NotificationPreference[];
  onError: (message: string) => void;
  isCurrent: () => boolean;
}): JSX.Element {
  const [preferences, setPreferences] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPreferences(initial), [initial]);
  const save = async (): Promise<void> => {
    setBusy(true);
    onError("");
    try {
      await savePreferences(context, preferences);
    } catch (error) {
      if (!isCurrent()) return;
      onError(error instanceof Error ? error.message : "Preferences could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className={styles.panel}>
      <h2>Notification preferences</h2>
      <ul className={styles.list}>
        {preferences.map((preference, index) => (
          <li className={styles.row} key={preference.eventType}>
            <div>
              <strong>{preference.eventType}</strong>
              <small>{preference.description}</small>
            </div>
            <label>
              <input
                type="checkbox"
                checked={preference.inApp}
                onChange={(event) =>
                  setPreferences(
                    preferences.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, inApp: event.target.checked } : item,
                    ),
                  )
                }
              />{" "}
              In-app
            </label>
            <label>
              <input
                type="checkbox"
                checked={preference.email}
                onChange={(event) =>
                  setPreferences(
                    preferences.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, email: event.target.checked } : item,
                    ),
                  )
                }
              />{" "}
              Email
            </label>
          </li>
        ))}
      </ul>
      <Button disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save preferences"}
      </Button>
    </Panel>
  );
}

function BudgetEditor({
  context,
  onSaved,
  onError,
}: {
  context: M29Context;
  onSaved: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [monthly, setMonthly] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    const monthlyLimitMinor = Number(monthly);
    if (
      !/^[A-Z]{3}$/.test(currencyCode) ||
      !Number.isInteger(monthlyLimitMinor) ||
      monthlyLimitMinor <= 0 ||
      reason.trim().length === 0
    ) {
      onError(
        "Enter a valid three-letter currency, positive monthly limit in minor units, and reason.",
      );
      return;
    }
    setBusy(true);
    onError("");
    try {
      await saveBudget(context, {
        currency: currencyCode,
        monthlyLimitMinor,
        reason: reason.trim(),
      });
      onSaved();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Budget could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className={styles.panel}>
      <h2>Budget settings</h2>
      <p className={styles.muted}>
        Owner-only. Limits use minor currency units and are accounting caps, not subscription
        charges.
      </p>
      <div className={styles.editor}>
        <Field
          id="m29-budget-currency"
          label="Currency"
          value={currencyCode}
          maxLength={3}
          onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())}
        />
        <Field
          id="m29-budget-monthly"
          label="Monthly limit (minor units)"
          inputMode="numeric"
          value={monthly}
          onChange={(event) => setMonthly(event.target.value)}
        />
        <Field
          id="m29-budget-reason"
          label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <Button disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save budget"}
      </Button>
    </Panel>
  );
}

export function M29Dashboard({ context }: { context: M29Context }): JSX.Element {
  const [data, setData] = useState<M29Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState("");
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const refresh = useCallback(() => {
    const current = ++version.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    void loadM29Data(context, controller.signal)
      .then((next) => {
        if (current === version.current) setData(next);
      })
      .catch((e: unknown) => {
        if (current === version.current && !(e instanceof DOMException && e.name === "AbortError"))
          setError(e instanceof Error ? e.message : "M29 data could not be loaded.");
      })
      .finally(() => {
        if (current === version.current) setLoading(false);
      });
    return (): void => controller.abort();
  }, [context]);
  useEffect(() => refresh(), [refresh]);
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
  const currentGeneration = version.current;
  const isCurrent = (): boolean => currentGeneration === version.current;
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
      {mutationError && (
        <Alert tone="danger" title="Change not saved">
          {mutationError}
        </Alert>
      )}
      <div className={styles.grid}>
        <Panel className={styles.panel}>
          <h2>Workflow runs</h2>
          <p className={styles.muted}>
            Actions are permission- and state-gated; the backend remains authoritative.
          </p>
          <ul className={styles.list}>
            {data.runs.length ? (
              data.runs.map((run) => (
                <RunCard
                  key={run.id}
                  context={context}
                  run={run}
                  onChanged={() => {
                    if (isCurrent()) refresh();
                  }}
                  isCurrent={isCurrent}
                />
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
              onClick={() => {
                setMutationError("");
                const generation = version.current;
                void markAllNotificationsRead(context)
                  .then(() => {
                    if (generation === version.current) refresh();
                  })
                  .catch((e: unknown) => {
                    if (generation === version.current)
                      setMutationError(
                        e instanceof Error ? e.message : "Notifications could not be updated.",
                      );
                  });
              }}
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
                      onClick={() => {
                        setMutationError("");
                        const generation = version.current;
                        void markNotificationRead(context, notification.id)
                          .then(() => {
                            if (generation === version.current) refresh();
                          })
                          .catch((e: unknown) => {
                            if (generation === version.current)
                              setMutationError(
                                e instanceof Error
                                  ? e.message
                                  : "Notification could not be updated.",
                              );
                          });
                      }}
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
            Consumption and budget accounting only — not subscription billing or invoices. Period:{" "}
            {data.usage.periodKey} ({data.usage.timezone}).
          </p>
          {data.usage.currencies.length ? (
            data.usage.currencies.map((item) => (
              <div className={styles.currency} key={item.currency}>
                <h3>{item.currency}</h3>
                <div className={styles.details}>
                  <div>
                    <span>Recorded</span>
                    <strong>{currency(item.totalMinor, item.currency)}</strong>
                  </div>
                  <div>
                    <span>Actual / estimated</span>
                    <strong>
                      {currency(item.actualMinor, item.currency)} /{" "}
                      {currency(item.estimatedMinor + item.failedEstimatedMinor, item.currency)}
                    </strong>
                  </div>
                  <div>
                    <span>Reserved</span>
                    <strong>{currency(item.reservedMinor, item.currency)}</strong>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <StateMessage kind="empty" description="No priced usage recorded for this period." />
          )}
          <p className={styles.muted}>
            Unknown cost: {data.usage.unknownCostRequests}; unpriced: {data.usage.unpricedRequests};
            not dispatched: {data.usage.notDispatchedRequests}.
          </p>
          {data.budgets.map((budget) => (
            <div className={styles.currency} key={budget.budgetId}>
              <h3>
                {budget.scope} budget · {budget.currency}
              </h3>
              {budget.periods.map((period) => (
                <div className={styles.details} key={period.period}>
                  <div>
                    <span>{period.period}</span>
                    <strong>
                      {currency(period.consumedMinor, budget.currency)} /{" "}
                      {currency(period.limitMinor, budget.currency)}
                    </strong>
                  </div>
                  <small>
                    {period.exhausted
                      ? "Budget exhausted; paid work is blocked."
                      : `${currency(period.remainingMinor, budget.currency)} remaining`}
                  </small>
                </div>
              ))}
            </div>
          ))}
        </Panel>
      </div>
      <Preferences
        context={context}
        initial={data.preferences}
        onError={(message) => {
          if (isCurrent()) setMutationError(message);
        }}
        isCurrent={isCurrent}
      />
      {context.role === "OWNER" && (
        <BudgetEditor
          context={context}
          onSaved={() => {
            if (isCurrent()) refresh();
          }}
          onError={(message) => {
            if (isCurrent()) setMutationError(message);
          }}
        />
      )}
      <Panel className={styles.panel}>
        <h2>Budget history</h2>
        <ul className={styles.list}>
          {data.audit.length ? (
            data.audit.map((item) => (
              <li className={styles.row} key={item.id}>
                <span>
                  {item.action}: {item.reason}
                </span>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
              </li>
            ))
          ) : (
            <StateMessage kind="empty" description="No budget audit records." />
          )}
        </ul>
      </Panel>
      {context.role !== "OWNER" && (
        <Alert tone="info" title="Budget settings are owner-only">
          You can view usage and history. Only workspace owners can change caps or record
          adjustments.
        </Alert>
      )}
    </main>
  );
}
