"use client";
import { useMemo, useRef, useState, type JSX } from "react";
import { useRouter } from "next/navigation";
import { navigateWithIntent } from "../../components/studio-navigation";
import { Alert, Badge, Button, Panel, StateMessage } from "../../components/ui/primitives";
import { ProductionApiError } from "./api";
import { LoadResult } from "./common";
import { canWrite, statusTone, type RequestedOutputs } from "./model";
import styles from "./production.module.css";
import { useLoad, useProduction } from "./session";

export function ProductionStart({ scriptId }: { scriptId: string }): JSX.Element {
  const router = useRouter();
  const { client, refresh } = useProduction();
  const state = useLoad(async (api) => {
    const [script, capabilities, jobs, costs] = await Promise.all([
      api.script(scriptId),
      api.capabilities(),
      api.sceneJobs(1, scriptId),
      api.costs(scriptId),
    ]);
    return { script, capabilities, jobs, costs };
  }, `production-start:${scriptId}`);
  const [outputs, setOutputs] = useState<RequestedOutputs>({
    image: true,
    video: false,
    narration: false,
    dialogue: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const operationKey = useRef<string | null>(null);
  const capability = useMemo(
    () => new Map(state.data?.capabilities.capabilities.map((item) => [item.kind, item])),
    [state.data],
  );
  const script = state.data?.script;
  const imageAvailable = capability.get("IMAGE")?.available === true;
  const writable = canWrite(client.role);

  const create = async (): Promise<void> => {
    if (!script || !imageAvailable || uncertain) return;
    setBusy(true);
    setError("");
    operationKey.current ??= crypto.randomUUID();
    try {
      const job = await client.createJob(script, outputs, operationKey.current);
      operationKey.current = null;
      navigateWithIntent(`/production/jobs/${job.jobId}`, router.push);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Production could not be started.");
      setUncertain(cause instanceof ProductionApiError && cause.uncertain);
      if (!(cause instanceof ProductionApiError) || !cause.uncertain) operationKey.current = null;
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async (): Promise<void> => {
    if (!operationKey.current) return;
    setBusy(true);
    setError("");
    try {
      const page = await client.sceneJobs(1, scriptId);
      const found = page.items.find((job) => job.idempotencyKey === operationKey.current);
      if (found) {
        operationKey.current = null;
        setUncertain(false);
        navigateWithIntent(`/production/jobs/${found.jobId}`, router.push);
      } else {
        setUncertain(false);
        setError("No committed job was found. You may retry the same request key.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be reconciled.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.workspace}>
      <LoadResult state={state} onRetry={refresh}>
        {script && (
          <>
            <header className={styles.header}>
              <div>
                <p className="rf-eyebrow">Generation setup · revision {script.currentRevision}</p>
                <h1>{script.revisions[0]?.document.title}</h1>
                <p>Choose only capabilities the server confirms for this environment.</p>
              </div>
              <Badge tone={script.status === "APPROVED" ? "success" : "warning"}>
                {script.status}
              </Badge>
            </header>
            {error && (
              <Alert
                tone={uncertain ? "warning" : "danger"}
                title={uncertain ? "Response interrupted" : "Unable to start production"}
              >
                {error}
              </Alert>
            )}
            {uncertain && (
              <Button loading={busy} onClick={reconcile}>
                Reconcile saved state
              </Button>
            )}
            <Panel>
              <h2>Generation route</h2>
              <div className={styles.checkboxes}>
                {(["IMAGE", "VIDEO", "NARRATION", "DIALOGUE"] as const).map((kind) => {
                  const item = capability.get(kind);
                  const field = kind.toLowerCase() as "image" | "video" | "narration" | "dialogue";
                  return (
                    <label key={kind} title={item?.message}>
                      <input
                        type="checkbox"
                        checked={outputs[field]}
                        disabled={kind === "IMAGE" || !item?.available || busy || uncertain}
                        onChange={(event) =>
                          setOutputs({ ...outputs, [field]: event.target.checked })
                        }
                      />
                      <span>{kind === "NARRATION" ? "Narration voice" : kind.toLowerCase()}</span>
                      <Badge tone={item?.available ? "success" : "neutral"}>
                        {item?.available ? "Available" : "Unavailable"}
                      </Badge>
                    </label>
                  );
                })}
              </div>
              <div className={styles.actions}>
                <Button
                  loading={busy}
                  disabled={
                    !writable || script.status !== "APPROVED" || !imageAvailable || uncertain
                  }
                  onClick={create}
                >
                  Start scene generation
                </Button>
              </div>
              {!writable && (
                <p className={styles.notice}>
                  Viewer access is read-only. An Owner or Editor can start generation.
                </p>
              )}
              {!imageAvailable && (
                <StateMessage
                  kind="unavailable"
                  description={
                    capability.get("IMAGE")?.message ?? "Image generation is not configured."
                  }
                />
              )}
            </Panel>
            <CostPanel costs={state.data!.costs} />
            <Panel>
              <h2>Production history</h2>
              {state.data!.jobs.items.length === 0 ? (
                <StateMessage
                  kind="empty"
                  description="No persisted production jobs exist for this script."
                />
              ) : (
                <ul className={styles.list}>
                  {state.data!.jobs.items.map((job) => (
                    <li key={job.jobId}>
                      <a className={styles.card} href={`/production/jobs/${job.jobId}`}>
                        <span className={styles.cardHead}>
                          <strong>{job.jobId.slice(0, 8)}</strong>
                          <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                        </span>
                        <span className={styles.meta}>
                          Revision {job.scriptRevision} · version {job.version}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}
      </LoadResult>
    </section>
  );
}

export function CostPanel({ costs }: { costs: import("./model").CostBreakdown }): JSX.Element {
  return (
    <Panel>
      <h2>Cost & budget</h2>
      {costs.totals.currencies.length === 0 ? (
        <StateMessage
          kind="empty"
          description={
            costs.totals.unknownCostRequests > 0
              ? `${costs.totals.unknownCostRequests} request costs are unknown.`
              : "No authoritative spend is recorded for this script."
          }
        />
      ) : (
        <div className={styles.costs}>
          {costs.totals.currencies.map((currency) => (
            <div className={styles.cost} key={currency.currency}>
              <span>{currency.currency}</span>
              <strong>{(currency.totalMinor / 100).toFixed(2)}</strong>
              <small>
                {(currency.actualMinor / 100).toFixed(2)} actual ·{" "}
                {(currency.estimatedMinor / 100).toFixed(2)} estimated
              </small>
            </div>
          ))}
        </div>
      )}
      {costs.totals.unknownCostRequests > 0 && (
        <p className={styles.notice}>
          {costs.totals.unknownCostRequests} provider request cost
          {costs.totals.unknownCostRequests === 1 ? " is" : "s are"} unknown and excluded from
          totals.
        </p>
      )}
      {costs.budgets.length === 0 ? (
        <p className={styles.meta}>No applicable persisted budget is configured.</p>
      ) : (
        costs.budgets.map((budget) => (
          <p className={styles.meta} key={budget.budgetId}>
            {budget.scope} budget · {budget.currency} · daily{" "}
            {budget.dailyLimitMinor === null
              ? "not set"
              : (budget.dailyLimitMinor / 100).toFixed(2)}{" "}
            · monthly{" "}
            {budget.monthlyLimitMinor === null
              ? "not set"
              : (budget.monthlyLimitMinor / 100).toFixed(2)}
          </p>
        ))
      )}
    </Panel>
  );
}
