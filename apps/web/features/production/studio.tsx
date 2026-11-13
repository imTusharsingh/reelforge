"use client";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge, Button, Panel, StateMessage } from "../../components/ui/primitives";
import { ProductionApiError } from "./api";
import { makeRenderInput } from "./composition";
import { LoadResult } from "./common";
import {
  canWrite,
  mediaPath,
  statusTone,
  type OutputKind,
  type ProductionScene,
  type SceneMediaPackage,
} from "./model";
import styles from "./production.module.css";
import { CostPanel } from "./start";
import { useLoad, useProduction } from "./session";

export function ProductionStudio({ jobId }: { jobId: string }): JSX.Element {
  const { client, refresh } = useProduction();
  const state = useLoad(async (api) => {
    const job = await api.package(jobId);
    const [scriptRevision, capabilities, assets, renders, costs] = await Promise.all([
      api.scriptRevision(job.scriptId, job.scriptRevision),
      api.capabilities(),
      api.assets(),
      api.renders(1, job.scriptId),
      api.costs(job.scriptId),
    ]);
    if (scriptRevision.revision !== job.scriptRevision)
      throw new Error("The production job references a mismatched script revision.");
    return { job, scriptRevision, capabilities, assets, renders, costs };
  }, `production-job:${jobId}`);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const pendingMutation = useRef<PendingSceneMutation | null>(null);
  useEffect((): (() => void) | undefined => {
    if (state.data?.job.status !== "RUNNING" && state.data?.job.status !== "QUEUED") return;
    const timer = window.setInterval(refresh, 5000);
    return (): void => window.clearInterval(timer);
  }, [refresh, state.data?.job.status]);
  const capability = useMemo(
    () => new Map(state.data?.capabilities.capabilities.map((item) => [item.kind, item])),
    [state.data],
  );
  const job = state.data?.job;
  const scriptRevision = state.data?.scriptRevision;
  const scene = job?.scenes[selected] ?? null;
  const scriptScene = scene
    ? scriptRevision?.document.scenes.find((item) => item.id === scene.sceneId)
    : undefined;
  const allAvailable = job
    ? (
        [
          "IMAGE",
          ...(job.requestedOutputs.video ? ["VIDEO"] : []),
          ...(job.requestedOutputs.narration ? ["NARRATION"] : []),
          ...(job.requestedOutputs.dialogue ? ["DIALOGUE"] : []),
        ] as OutputKind[]
      ).every((kind) => capability.get(kind)?.available)
    : false;

  const dispatchMutation = async (
    attempt: PendingSceneMutation,
    reconciling = false,
  ): Promise<void> => {
    setBusy(reconciling ? "reconcile" : attempt.label);
    setError("");
    setNotice("");
    try {
      const updated = await client.mutate(
        attempt.job,
        attempt.operation,
        attempt.key,
        attempt.sceneId,
        attempt.kind,
      );
      pendingMutation.current = null;
      setUncertain(false);
      setNotice(
        `Request accepted. Job version is now ${updated.version}; displayed state was refreshed.`,
      );
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The production action failed.");
      const outcomeUncertain = cause instanceof ProductionApiError && cause.uncertain;
      if (outcomeUncertain || reconciling) {
        pendingMutation.current = attempt;
        setUncertain(true);
      } else {
        pendingMutation.current = null;
        setUncertain(false);
      }
    } finally {
      setBusy("");
    }
  };

  const mutate = async (
    operation: "retry" | "regenerate" | "replace",
    target?: ProductionScene,
    kind?: OutputKind,
  ): Promise<void> => {
    if (!job || uncertain) return;
    const attempt: PendingSceneMutation = {
      job,
      operation,
      key: crypto.randomUUID(),
      label: `${operation}:${target?.sceneId ?? "job"}:${kind ?? "all"}`,
      ...(target ? { sceneId: target.sceneId } : {}),
      ...(kind ? { kind } : {}),
    };
    pendingMutation.current = attempt;
    await dispatchMutation(attempt);
  };

  const reconcile = async (): Promise<void> => {
    const attempt = pendingMutation.current;
    if (!attempt) return;
    setBusy("reconcile");
    setError("");
    try {
      const observed = await client.package(jobId);
      if (observed.version !== attempt.job.version) {
        pendingMutation.current = null;
        setUncertain(false);
        setNotice(
          `The server advanced this job to version ${observed.version}. Inspect the persisted output before another action.`,
        );
        refresh();
        return;
      }
      setNotice("No newer job version is visible. Replaying the exact saved request key safely.");
      await dispatchMutation(attempt, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconciliation failed.");
      setBusy("");
    }
  };

  return (
    <section className={styles.workspace}>
      <LoadResult state={state} onRetry={refresh}>
        {job && scriptRevision && (
          <>
            <header className={styles.header}>
              <div>
                <p className="rf-eyebrow">Generation studio · revision {job.scriptRevision}</p>
                <h1>{scriptRevision.document.title}</h1>
                <p>{scriptRevision.document.hook}</p>
              </div>
              <div className={styles.actions}>
                <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                <Button tone="secondary" onClick={refresh}>
                  Refresh persisted state
                </Button>
              </div>
            </header>
            <p className={styles.srStatus} aria-live="polite">
              {notice}
            </p>
            {error && (
              <Alert tone="danger" title={uncertain ? "Response interrupted" : "Action failed"}>
                {error}
              </Alert>
            )}
            {uncertain && (
              <Button loading={busy === "reconcile"} onClick={reconcile}>
                Reconcile from server
              </Button>
            )}
            <div className={styles.grid}>
              <main className={styles.workspace}>
                <Timeline
                  scenes={job.scenes}
                  selected={selected}
                  onSelect={setSelected}
                  scriptScenes={scriptRevision.document.scenes}
                />
                {scene && scriptScene && (
                  <SceneWorkspace
                    scene={scene}
                    scriptScene={scriptScene}
                    workspaceId={client.workspaceId}
                    writable={canWrite(client.role)}
                    busy={busy}
                    uncertain={uncertain}
                    capability={capability}
                    allAvailable={allAvailable}
                    mutate={mutate}
                  />
                )}
              </main>
              <aside className={styles.workspace} aria-label="Production inspector">
                <Panel>
                  <h2>Job control</h2>
                  <p className={styles.meta}>
                    Job {job.jobId} · observed version {job.version}
                  </p>
                  <p>
                    Approved script revision, configuration and prompt snapshots are pinned by the
                    server.
                  </p>
                  <Button
                    tone="secondary"
                    loading={busy === "retry:job:all"}
                    disabled={
                      !canWrite(client.role) ||
                      !allAvailable ||
                      uncertain ||
                      job.status === "SUCCEEDED"
                    }
                    onClick={() => mutate("retry")}
                  >
                    Retry failed outputs
                  </Button>
                  {!allAvailable && (
                    <p className={styles.notice}>
                      Retry is unavailable while one or more required providers are not configured.
                    </p>
                  )}
                </Panel>
                <CostPanel costs={state.data!.costs} />
              </aside>
            </div>
            <AssetGallery assets={state.data!.assets} workspaceId={client.workspaceId} />
            <Panel>
              <h2>Render & export history</h2>
              <RenderStart job={job} revision={scriptRevision} />
              {state.data!.renders.items.length === 0 ? (
                <StateMessage
                  kind="empty"
                  description="No persisted render exists for this script."
                />
              ) : (
                <ul className={styles.list}>
                  {state.data!.renders.items.map((render) => (
                    <li key={render.jobId}>
                      <StudioLink
                        className={styles.card}
                        href={`/production/renders/${render.jobId}`}
                      >
                        <span className={styles.cardHead}>
                          <strong>Render {render.jobId.slice(0, 8)}</strong>
                          <Badge tone={statusTone(render.status)}>{render.status}</Badge>
                        </span>
                        <span className={styles.meta}>
                          {render.artifactCount} persisted artifacts · attempt {render.attempt}
                        </span>
                      </StudioLink>
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

function RenderStart({
  job,
  revision,
}: {
  job: SceneMediaPackage;
  revision: import("./model").ScriptRevision;
}): JSX.Element {
  const { client } = useProduction();
  const marker = `reelforge.render.pending:${client.workspaceId}:${job.jobId}`;
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  useEffect(() => {
    try {
      setPending(sessionStorage.getItem(marker) !== null);
    } catch {
      setPending(true);
      setError("Storage is unavailable; render creation is disabled.");
    }
  }, [marker]);
  let reason = "";
  try {
    makeRenderInput(job, revision, "validation-seed");
  } catch (cause) {
    reason = cause instanceof Error ? cause.message : "Production is not ready to render.";
  }
  const start = async (): Promise<void> => {
    if (!canWrite(client.role) || pending !== false || busy || reason || created) return;
    if (
      !window.confirm("Start a render using the pinned scene images and available voice outputs?")
    )
      return;
    setBusy(true);
    setError("");
    try {
      const key = crypto.randomUUID();
      const input = makeRenderInput(job, revision, crypto.randomUUID());
      sessionStorage.setItem(marker, key);
      setPending(true);
      const result = await client.startRender(input, key);
      sessionStorage.removeItem(marker);
      setPending(false);
      setCreated(result.id);
    } catch (cause) {
      const uncertain = !(cause instanceof ProductionApiError) || cause.uncertain;
      if (!uncertain) {
        sessionStorage.removeItem(marker);
        setPending(false);
      }
      setError(cause instanceof Error ? cause.message : "Render could not be started.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.workspace}>
      <p>
        Creates a vertical render using each scene’s image (or video if no image exists), one voice
        output, cuts, and the first scene as its cover. Captions and music are not included.
      </p>
      {reason && <p className={styles.notice}>{reason}</p>}
      {error && (
        <Alert tone="danger" title="Render could not be started">
          {error}
        </Alert>
      )}
      {pending && (
        <Alert tone="warning" title="Render request needs review">
          The previous request may have succeeded. Refresh and inspect render history before
          starting another render; no request is retried automatically.{" "}
          <Button
            tone="secondary"
            onClick={() => {
              if (window.confirm("Have you checked the render history for the earlier request?")) {
                try {
                  sessionStorage.removeItem(marker);
                  setPending(false);
                  setError("");
                } catch {
                  setError("Storage is unavailable; render creation is disabled.");
                }
              }
            }}
          >
            I checked render history
          </Button>
        </Alert>
      )}
      <Button
        loading={busy}
        disabled={
          !canWrite(client.role) || pending !== false || busy || Boolean(reason) || Boolean(created)
        }
        onClick={() => void start()}
      >
        Start render
      </Button>
      {created && (
        <p role="status">
          Render started.{" "}
          <StudioLink href={`/production/renders/${encodeURIComponent(created)}`}>
            Open render
          </StudioLink>
        </p>
      )}
    </div>
  );
}

function Timeline({
  scenes,
  selected,
  onSelect,
  scriptScenes,
}: {
  scenes: ProductionScene[];
  selected: number;
  onSelect: (index: number) => void;
  scriptScenes: import("./model").ScriptScene[];
}): JSX.Element {
  return (
    <div>
      <h2>Scene sequence</h2>
      <div className={styles.timeline} role="list" aria-label="Scene timeline">
        {scenes.map((scene, index) => {
          const script = scriptScenes.find((item) => item.id === scene.sceneId);
          return (
            <button
              key={scene.sceneId}
              type="button"
              role="listitem"
              aria-pressed={selected === index}
              onClick={() => onSelect(index)}
            >
              <strong>Scene {scene.ordinal + 1}</strong>
              <span>
                {script?.startSeconds ?? 0}s–
                {(script?.startSeconds ?? 0) + (script?.durationSeconds ?? 0)}s
              </span>
              <Badge tone={statusTone(scene.status)}>{scene.status}</Badge>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SceneWorkspace({
  scene,
  scriptScene,
  workspaceId,
  writable,
  busy,
  uncertain,
  capability,
  allAvailable,
  mutate,
}: {
  scene: ProductionScene;
  scriptScene: import("./model").ScriptScene;
  workspaceId: string;
  writable: boolean;
  busy: string;
  uncertain: boolean;
  capability: Map<OutputKind, import("./model").Capability>;
  allAvailable: boolean;
  mutate: (
    operation: "retry" | "regenerate" | "replace",
    scene?: ProductionScene,
    kind?: OutputKind,
  ) => Promise<void>;
}): JSX.Element {
  return (
    <article className={styles.scene}>
      <div className={styles.sceneHead}>
        <div>
          <p className="rf-eyebrow">
            Scene {scene.ordinal + 1} · {scriptScene.durationSeconds}s
          </p>
          <h2>{scriptScene.visualDescription}</h2>
        </div>
        <Badge tone={statusTone(scene.status)}>{scene.status}</Badge>
      </div>
      <p>
        <strong>Camera</strong> · {scriptScene.camera}
      </p>
      <div className={styles.grid}>
        <div>
          <h3>Narration</h3>
          <p>{scriptScene.narration?.trim() || "No narration in the approved scene."}</p>
        </div>
        <div>
          <h3>Dialogue</h3>
          <p>{scriptScene.dialogue.trim() || "No dialogue in the approved scene."}</p>
        </div>
      </div>
      <div className={styles.outputGrid}>
        {scene.outputs.map((output) => (
          <div className={styles.output} key={output.kind}>
            <span className={styles.cardHead}>
              <strong>{output.kind}</strong>
              <Badge tone={statusTone(output.status)}>{output.status}</Badge>
            </span>
            {output.assetId && output.assetVersion ? (
              <MediaPreview
                label={`Scene ${scene.ordinal + 1} ${output.kind.toLowerCase()}`}
                mediaType={output.mediaType}
                src={mediaPath(workspaceId, { id: output.assetId, version: output.assetVersion })}
              />
            ) : (
              <p className={styles.meta}>
                {output.errorMessage ?? "No persisted media is available."}
              </p>
            )}
            <Button
              tone="secondary"
              loading={busy === `replace:${scene.sceneId}:${output.kind}`}
              disabled={!writable || !capability.get(output.kind)?.available || uncertain}
              title={capability.get(output.kind)?.message}
              onClick={() => mutate("replace", scene, output.kind)}
            >
              Regenerate {output.kind.toLowerCase()}
            </Button>
          </div>
        ))}
      </div>
      <Button
        tone="secondary"
        loading={busy === `regenerate:${scene.sceneId}:all`}
        disabled={!writable || !allAvailable || uncertain}
        onClick={() => mutate("regenerate", scene)}
      >
        Regenerate entire scene
      </Button>
      <p className={styles.notice}>
        “Replace” regenerates the selected output through its configured provider. Assigning an
        existing library asset is not supported by the current server contract.
      </p>
    </article>
  );
}

export function MediaPreview({
  label,
  mediaType,
  src,
}: {
  label: string;
  mediaType: string | null;
  src: string;
}): JSX.Element {
  const identity = `${mediaType ?? "unknown"}:${src}`;
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  if (failedIdentity === identity)
    return (
      <StateMessage
        kind="error"
        description={`${label} could not be loaded. It may be missing, invalid or expired.`}
      />
    );
  if (mediaType?.startsWith("video/"))
    return (
      <video
        controls
        preload="metadata"
        aria-label={label}
        src={src}
        onError={() => setFailedIdentity(identity)}
      />
    );
  if (mediaType?.startsWith("audio/"))
    return (
      <audio
        controls
        preload="metadata"
        aria-label={label}
        src={src}
        onError={() => setFailedIdentity(identity)}
      />
    );
  if (mediaType?.startsWith("image/"))
    return <img alt={label} loading="lazy" src={src} onError={() => setFailedIdentity(identity)} />;
  return (
    <StateMessage
      kind="unavailable"
      description="This media type cannot be previewed in the browser."
    />
  );
}

type PendingSceneMutation = {
  job: SceneMediaPackage;
  operation: "retry" | "regenerate" | "replace";
  key: string;
  label: string;
  sceneId?: string;
  kind?: OutputKind;
};

function AssetGallery({
  assets,
  workspaceId,
}: {
  assets: import("./model").Asset[];
  workspaceId: string;
}): JSX.Element {
  const published = assets.filter((asset) => asset.status === "PUBLISHED");
  return (
    <Panel>
      <h2>Workspace asset gallery</h2>
      <p>
        Published immutable versions are available for inspection. Scene assignment is unavailable
        until the server exposes a rights-checked assignment operation.
      </p>
      {published.length === 0 ? (
        <StateMessage kind="empty" description="No published assets exist in this workspace." />
      ) : (
        <div className={styles.assetGrid}>
          {published.map((asset) => (
            <article className={styles.asset} key={asset.id}>
              <MediaPreview
                label={asset.filename ?? `Asset ${asset.id}`}
                mediaType={asset.mediaType}
                src={mediaPath(workspaceId, asset)}
              />
              <strong>{asset.filename ?? "Untitled asset"}</strong>
              <span className={styles.meta}>
                Version {asset.version} · {asset.mediaType}
              </span>
              <Button disabled>Select for scene</Button>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
