"use client";
import { useRef, useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import {
  Alert,
  Badge,
  Button,
  Panel,
  SelectField,
  StateMessage,
  TextAreaField,
} from "../../components/ui/primitives";
import { useDirty } from "../planning/session";
import { artifactPath, type RenderJob } from "../production/model";
import { MediaPreview } from "../production/studio";
import {
  criteria,
  gateIds,
  gatesPass,
  label,
  needsOverride,
  pending,
  readiness,
  regenerationHref,
  renderContext,
  type Action,
  type Decision,
  type Gate,
  type Run,
  type Stage,
  type Status,
} from "./model";
import { useLoad, useReview } from "./session";
import styles from "./review.module.css";
const tone = (status: Status): "success" | "danger" | "warning" | "neutral" =>
  ["APPROVED", "AUTO_APPROVED"].includes(status)
    ? "success"
    : ["BLOCKED", "REJECTED"].includes(status)
      ? "danger"
      : status === "SUPERSEDED"
        ? "neutral"
        : "warning";
const when = (timestamp: string): string => new Date(timestamp).toLocaleString();
function Feedback({ loading, error }: { loading: boolean; error: string }): JSX.Element | null {
  const { refresh } = useReview();
  return loading ? (
    <StateMessage kind="loading" description="Fetching persisted review state…" />
  ) : error ? (
    <StateMessage
      kind="error"
      description={error}
      action={
        <Button tone="secondary" onClick={refresh}>
          Retry read
        </Button>
      }
    />
  ) : null;
}
export function ReviewQueue(): JSX.Element {
  const state = useLoad((api) => api.queue(), "queue");
  const { refresh } = useReview();
  return (
    <section className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <p className="rf-eyebrow">Quality desk</p>
          <h1>Review queue</h1>
          <p>Up to 50 current pending reviews, oldest first. Completed reviews are not included.</p>
        </div>
        <Button tone="secondary" disabled={state.loading} onClick={refresh}>
          Refresh queue
        </Button>
      </header>
      <Feedback {...state} />
      {state.data &&
        (state.data.length === 0 ? (
          <StateMessage
            kind="empty"
            description="No pending reviews were returned for this workspace."
            action={<StudioLink href="/production">Open Production</StudioLink>}
          />
        ) : (
          <ol className={styles.list}>
            {state.data.map((run, index) => (
              <li key={run.id}>
                <StudioLink
                  className={styles.card}
                  href={`/review/runs/${encodeURIComponent(run.id)}`}
                >
                  <div className={styles.header}>
                    <h2>Render {run.renderJobId.slice(0, 8)}</h2>
                    <Badge tone={tone(run.status)}>{label(run.status)}</Badge>
                  </div>
                  <p>
                    Queue position {index + 1} · waiting since {when(run.createdAt)}
                  </p>
                  <p>
                    {run.gateSummary.filter((g) => !g.passed).length} failed hard gates ·{" "}
                    {run.scorecard
                      ? "Persisted AI evaluation available"
                      : run.status === "AI_REVIEW_UNAVAILABLE"
                        ? "AI evaluation unavailable"
                        : "No AI scorecard recorded"}
                  </p>
                  <span>Inspect evidence and review →</span>
                </StudioLink>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
export function Gates({ gates }: { gates: Gate[] }): JSX.Element {
  return (
    <div className={styles.gates}>
      {gateIds.map((id) => {
        const gate = gates.find((g) => g.id === id);
        const unavailable = !gate || !gate.evidence.length;
        return (
          <article className={styles.gate} key={id}>
            <div className={styles.header}>
              <h3>{label(id)}</h3>
              <Badge tone={unavailable ? "warning" : gate.passed ? "success" : "danger"}>
                {unavailable ? "Evidence unavailable" : gate.passed ? "Passed" : "Failed"}
              </Badge>
            </div>
            {unavailable ? (
              <p>No persisted evidence is available for this check.</p>
            ) : (
              <ul>
                {gate.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </div>
  );
}
function Readiness({ renderId }: { renderId: string }): JSX.Element {
  const state = useLoad((api) => api.status(renderId), `readiness:${renderId}`);
  const value = state.data ? readiness(state.data) : null;
  return (
    <Panel>
      <h2>Publishing readiness</h2>
      <Feedback {...state} />
      {value && (
        <>
          <Badge tone={value.eligible ? "success" : "warning"}>
            {value.eligible ? "Quality state eligible to proceed" : "Blocked from proceeding"}
          </Badge>
          {value.blockers.length > 0 && (
            <ul>
              {value.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          )}
          {state.data?.gateSummary && (
            <details>
              <summary>Current render hard-gate evidence</summary>
              <Gates gates={state.data.gateSummary} />
            </details>
          )}
        </>
      )}
      <p>
        This is the server’s current quality signal. Publishing rechecks the latest approval,
        policy, provenance and hard gates. No video is published by this screen.
      </p>
    </Panel>
  );
}
export function ReviewDetail({ runId }: { runId: string }): JSX.Element {
  const state = useLoad((api) => api.run(runId), `run:${runId}`);
  const { refresh } = useReview();
  const render = useLoad(async (api) => {
    const run = await api.run(runId);
    const result = await api.production.render(run.renderJobId);
    if (result.id !== run.renderJobId) throw new Error("Render identity mismatch.");
    return result;
  }, `render:${runId}`);
  const run = state.data;
  return (
    <section className={styles.workspace}>
      <div className={styles.header}>
        <StudioLink href="/review">← Review queue</StudioLink>
        <Button tone="secondary" disabled={state.loading} onClick={refresh}>
          Refresh review
        </Button>
      </div>
      <Feedback {...state} />
      {run && (
        <>
          <header className={styles.header}>
            <div>
              <p className="rf-eyebrow">Persisted quality review</p>
              <h1>Review {run.id.slice(0, 8)}</h1>
              <p>
                Render {run.renderJobId} · {when(run.createdAt)}
              </p>
            </div>
            <Badge tone={tone(run.status)}>{label(run.status)}</Badge>
          </header>
          {(run.supersededAt || run.status === "SUPERSEDED") && (
            <Alert tone="warning" title="Superseded review">
              This review is historical. Its decisions cannot be changed or used as a current
              approval.
            </Alert>
          )}
          <div className={styles.columns}>
            <div className={styles.workspace}>
              <Panel>
                <h2>Render preview</h2>
                <Feedback {...render} />
                {render.data && (
                  <>
                    <RenderPreview render={render.data} />
                    <h3>Pinned scenes</h3>
                    <p>
                      Render-level checks apply to this export. Inspect individual scene media in
                      Production.
                    </p>
                    {renderContext(render.data).sceneIds.length > 0 ? (
                      <ol>
                        {renderContext(render.data).sceneIds.map((id) => (
                          <li key={id}>
                            <StudioLink
                              href={`/production/jobs/${encodeURIComponent(render.data!.sceneMediaJobId)}`}
                            >
                              Inspect scene {id}
                            </StudioLink>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>Pinned scene context unavailable.</p>
                    )}
                  </>
                )}
                <StudioLink href={`/production/renders/${encodeURIComponent(run.renderJobId)}`}>
                  Open render in Production
                </StudioLink>
              </Panel>
              <Panel>
                <h2>Automated deterministic checks</h2>
                <p>Recorded hard gates are separate from AI evaluation and human approval.</p>
                <Gates gates={run.gateSummary} />
              </Panel>
              <Panel>
                <h2>AI evaluation</h2>
                {run.scorecard ? (
                  <>
                    <p>
                      Persisted overall score: <strong>{run.scorecard.score}/100</strong>
                    </p>
                    <p>
                      Model: {run.scorecard.metadata.modelVersion} · Prompt:{" "}
                      {run.scorecard.metadata.promptVersion}
                    </p>
                    {criteria.map((id) => {
                      const result = run.scorecard!.criteria[id];
                      return (
                        <article className={styles.gate} key={id}>
                          <h3>
                            {label(id)} · {result.score}/100
                          </h3>
                          <ul>
                            {result.evidence.map((e, i) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                          {result.limitations.map((l, i) => (
                            <p key={i}>Limitation: {l}</p>
                          ))}
                        </article>
                      );
                    })}
                  </>
                ) : (
                  <p>
                    No valid persisted AI scorecard is available. Scores and provider availability
                    cannot be inferred from deterministic checks.
                  </p>
                )}
                {run.status === "AUTO_APPROVED" && (
                  <Alert tone="info" title="Automatic approval">
                    This run was approved automatically under the recorded channel policy, rather
                    than by a human reviewer.
                  </Alert>
                )}
              </Panel>
              <Panel>
                <h2>Policy, disclosures and limitations</h2>
                <p>
                  Recorded approval policy: {label(run.policySnapshot.mode)} · score threshold{" "}
                  {run.policySnapshot.scoreThreshold}/100
                </p>
                {Object.entries(run.policySnapshot.criterionThresholds).map(([id, value]) => (
                  <p key={id}>
                    {label(id)} threshold: {value}/100
                  </p>
                ))}
                <h3>Disclosure flags</h3>
                {run.disclosures.length ? (
                  <ul>
                    {run.disclosures.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                ) : (
                  <p>No disclosure flags recorded. See disclosure gate evidence above.</p>
                )}
                <h3>Review limitations</h3>
                {run.limitations.length ? (
                  <ul>
                    {run.limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    No limitations recorded. This does not certify that all content risks were
                    evaluated.
                  </p>
                )}
              </Panel>
            </div>
            <div className={styles.workspace}>
              <Readiness renderId={run.renderJobId} />
              <DecisionForm
                key={run.id}
                run={run}
                render={render.data}
                blocked={state.loading || Boolean(state.error)}
              />
              <Panel>
                <h2>Human decision history</h2>
                {!run.decisions.length && <p>No human decisions recorded for this run.</p>}
                <ol className={styles.list}>
                  {run.decisions.map((d) => (
                    <li className={styles.gate} key={d.id}>
                      <h3>{label(d.action)}</h3>
                      <p>{d.reason}</p>
                      {d.overrideReason && <p>Override reason: {d.overrideReason}</p>}
                      <p>Reviewer ID: {d.actorUserId}</p>
                      <time dateTime={d.createdAt}>{when(d.createdAt)}</time>
                    </li>
                  ))}
                </ol>
                <h2>Regeneration requests</h2>
                <p>
                  These records request changes. They do not confirm that new media was generated.
                </p>
                {!run.regenerationRequests.length && <p>No regeneration requests recorded.</p>}
                <ol className={styles.list}>
                  {run.regenerationRequests.map((r) => {
                    const href = render.data ? regenerationHref(r.stage, render.data) : null;
                    return (
                      <li className={styles.gate} key={r.id}>
                        <h3>
                          {label(r.stage)} · attempt {r.attempt}
                        </h3>
                        {r.sceneId && <p>Scene: {r.sceneId}</p>}
                        <time dateTime={r.createdAt}>{when(r.createdAt)}</time>
                        {href ? (
                          <StudioLink href={href}>Open {label(r.stage)} workflow</StudioLink>
                        ) : (
                          <p>
                            Production context unavailable. Open the render to inspect its source.
                          </p>
                        )}
                        {r.stage === "RENDER" && (
                          <p>
                            {render.data?.status === "SUCCEEDED"
                              ? "This successful render cannot be retried."
                              : "Only failed retryable or canceled renders can be retried in the render workspace."}{" "}
                            Creating a new render from a review request is not supported.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </Panel>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function RenderPreview({ render }: { render: RenderJob }): JSX.Element {
  const { client } = useReview();
  const video = render.artifacts.find((a) => a.kind === "VIDEO");
  if (
    render.expiredAt !== null ||
    (video?.retainedUntil && Date.parse(video.retainedUntil) <= Date.now())
  )
    return <p>Render media has expired.</p>;
  if (render.status !== "SUCCEEDED" || !video)
    return <p>No accessible successful video artifact is available.</p>;
  return (
    <MediaPreview
      label="Quality review video"
      mediaType={video.mediaType}
      src={artifactPath(client.workspaceId, render.id, video.id)}
    />
  );
}
function DecisionForm({
  run,
  render,
  blocked,
}: {
  run: Run;
  render: RenderJob | null;
  blocked: boolean;
}): JSX.Element {
  const { client, refresh } = useReview();
  const [action, setAction] = useState<Action | "">("");
  const [reason, setReason] = useState("");
  const [stage, setStage] = useState<Stage | "">("");
  const [sceneId, setSceneId] = useState("");
  const [override, setOverride] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [uncertain, setUncertain] = useState(() => client.uncertain(run.id));
  const [reconciled, setReconciled] = useState<Run | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = !saved && Boolean(action || reason || stage || override);
  useDirty(`review:${run.id}`, dirty, () => {
    setAction("");
    setReason("");
    setStage("");
    setOverride("");
  });
  const readOnly =
    client.role === "VIEWER" || client.suspended || !pending(run) || saved || blocked;
  const submit = async (): Promise<void> => {
    if (lock.current || readOnly || uncertain) return;
    if (!action) {
      setError("Select a decision.");
      return;
    }
    if (!window.confirm(`Record ${label(action)} with the entered reason?`)) return;
    const decision: Decision = {
      action,
      reason: reason.trim(),
      ...(action === "REQUEST_CHANGES" && stage
        ? {
            regeneration: { stage, ...(stage === "SCENE" ? { sceneId } : {}) },
            ...(override.trim() && needsOverride(run, stage)
              ? { overrideReason: override.trim() }
              : {}),
          }
        : {}),
    };
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await client.decide(run, decision, render ? renderContext(render).sceneIds : []);
      setSaved(true);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Decision failed.");
      setUncertain(client.uncertain(run.id));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const reconcile = async (): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      setReconciled(await client.reconcile(run.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Read failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Panel>
      <h2>Human review</h2>
      {client.role === "VIEWER" && (
        <p>Viewer access is read-only. Owner or Editor permission is required to decide.</p>
      )}
      {!pending(run) && <p>This review is closed. Decisions cannot be repeated.</p>}
      {saved && <p role="status">Decision saved. Refreshing persisted history…</p>}
      {error && (
        <Alert tone="danger" title="Decision needs attention">
          {error}
        </Alert>
      )}
      {uncertain && (
        <div className={styles.gate}>
          <h3>Reconcile persisted state</h3>
          <p>The earlier request may have committed. It will not be repeated automatically.</p>
          <Button tone="secondary" disabled={busy} onClick={() => void reconcile()}>
            Fetch persisted review
          </Button>
          {reconciled && (
            <>
              <p>Fetched status: {label(reconciled.status)}</p>
              {reconciled.decisions.map((d) => (
                <p key={d.id}>
                  {label(d.action)}: {d.reason} · {when(d.createdAt)}
                </p>
              ))}
              <p>
                {pending(reconciled)
                  ? "No completed decision is visible in this read. Compare before taking another action."
                  : "A completed or superseded review cannot receive another decision."}
              </p>
              <Button
                tone="secondary"
                disabled={busy}
                onClick={() => {
                  try {
                    client.acknowledge(run.id);
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Browser recovery storage is unavailable.",
                    );
                    return;
                  }
                  setUncertain(false);
                  setAction("");
                  setReason("");
                  setStage("");
                  setOverride("");
                  setReconciled(null);
                  refresh();
                }}
              >
                I have compared the persisted state
              </Button>
            </>
          )}
        </div>
      )}
      <fieldset disabled={readOnly || busy || uncertain} className={styles.form}>
        <SelectField
          id="review-action"
          label="Decision"
          value={action}
          onChange={(e) => setAction(e.target.value as Action | "")}
        >
          <option value="">Choose a decision</option>
          <option
            value="APPROVE"
            disabled={run.status === "BLOCKED" || !gatesPass(run.gateSummary)}
          >
            Approve
          </option>
          <option value="REJECT">Reject</option>
          <option value="REQUEST_CHANGES">Request changes</option>
        </SelectField>
        <TextAreaField
          id="review-reason"
          label="Decision reason"
          required
          maxLength={4000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {action === "REQUEST_CHANGES" && (
          <>
            <SelectField
              id="review-stage"
              label="Regeneration target"
              value={stage}
              onChange={(e) => {
                setStage(e.target.value as Stage | "");
                setSceneId("");
              }}
            >
              <option value="">Choose a target</option>
              <option value="SCRIPT">Script</option>
              <option
                value="SCENE"
                disabled={!render || renderContext(render).sceneIds.length === 0}
              >
                Scene
              </option>
              <option value="RENDER">Render</option>
            </SelectField>
            {stage === "SCENE" && (
              <SelectField
                id="review-scene"
                label="Existing pinned scene"
                value={sceneId}
                onChange={(e) => setSceneId(e.target.value)}
              >
                <option value="">Choose a scene</option>
                {render &&
                  renderContext(render).sceneIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
              </SelectField>
            )}
            {stage && needsOverride(run, stage) && (
              <TextAreaField
                id="review-override"
                label="Override reason"
                required
                maxLength={1000}
                value={override}
                onChange={(e) => setOverride(e.target.value)}
                hint="A matching failed-gate route cannot be proven here. This explains the regeneration target; it cannot override a hard gate or authorize publishing."
              />
            )}
            <p>
              Recording changes creates a request only. Open the Production workflow afterward to
              explicitly start supported work.
            </p>
          </>
        )}
        <Button
          disabled={!action || !reason.trim()}
          loading={busy}
          tone={action === "REJECT" ? "danger" : "primary"}
          onClick={() => void submit()}
        >
          Record decision
        </Button>
      </fieldset>
    </Panel>
  );
}
