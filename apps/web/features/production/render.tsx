"use client";
import { useEffect, useRef, useState, type JSX } from "react";
import { Alert, Badge, Button, Panel, StateMessage } from "../../components/ui/primitives";
import { ProductionApiError } from "./api";
import { artifactPath, canWrite, statusTone } from "./model";
import { LoadResult } from "./common";
import { MediaPreview } from "./studio";
import styles from "./production.module.css";
import { useLoad, useProduction } from "./session";

export function RenderWorkspace({ jobId }: { jobId: string }): JSX.Element {
  const { client, refresh } = useProduction();
  const state = useLoad((api) => api.render(jobId), `render:${jobId}`);
  useEffect((): (() => void) | undefined => {
    if (state.data?.status !== "RUNNING" && state.data?.status !== "QUEUED") return;
    const timer = window.setInterval(refresh, 5000);
    return (): void => window.clearInterval(timer);
  }, [refresh, state.data?.status]);
  const render = state.data;
  const video = render?.artifacts.find((artifact) => artifact.kind === "VIDEO");
  const covers = render?.artifacts.filter((artifact) => artifact.kind === "COVER") ?? [];
  const expired =
    render?.expiredAt !== null ||
    (video?.retainedUntil ? Date.parse(video.retainedUntil) <= Date.now() : false);
  const [busy, setBusy] = useState<"cancel" | "retry" | "">("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const retryKey = useRef<string | null>(null);
  const cancel = async (): Promise<void> => {
    setBusy("cancel");
    setError("");
    try {
      await client.cancelRender(jobId);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The render could not be canceled.");
      setUncertain(cause instanceof ProductionApiError && cause.uncertain);
    } finally {
      setBusy("");
    }
  };
  const retry = async (): Promise<void> => {
    if (!render) return;
    retryKey.current ??= crypto.randomUUID();
    setBusy("retry");
    setError("");
    try {
      const child = await client.retryRender(render, retryKey.current);
      retryKey.current = null;
      window.location.assign(`/production/renders/${child.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The render retry could not be started.");
      setUncertain(cause instanceof ProductionApiError && cause.uncertain);
      if (!(cause instanceof ProductionApiError) || !cause.uncertain) retryKey.current = null;
    } finally {
      setBusy("");
    }
  };
  return (
    <section className={styles.workspace}>
      <LoadResult state={state} onRetry={refresh}>
        {render && (
          <>
            <header className={styles.header}>
              <div>
                <p className="rf-eyebrow">Production export</p>
                <h1>Render {render.id.slice(0, 8)}</h1>
                <p>
                  Attempt {render.attempt} · source production {render.sceneMediaJobId.slice(0, 8)}
                </p>
              </div>
              <div className={styles.actions}>
                <Badge tone={statusTone(render.status)}>{render.status}</Badge>
                <Button
                  tone="secondary"
                  loading={busy === "cancel"}
                  disabled={
                    !canWrite(client.role) ||
                    uncertain ||
                    !["QUEUED", "RUNNING"].includes(render.status)
                  }
                  onClick={cancel}
                >
                  Cancel render
                </Button>
                <Button
                  tone="secondary"
                  loading={busy === "retry"}
                  disabled={
                    !canWrite(client.role) ||
                    (uncertain && retryKey.current === null) ||
                    !["FAILED_RETRYABLE", "CANCELED"].includes(render.status)
                  }
                  onClick={retry}
                >
                  {uncertain && retryKey.current ? "Reconcile retry" : "Retry render"}
                </Button>
              </div>
            </header>
            {error && (
              <Alert
                tone="danger"
                title={uncertain ? "Outcome needs reconciliation" : "Render action failed"}
              >
                {error}
              </Alert>
            )}
            {uncertain && retryKey.current === null && (
              <p className={styles.notice}>
                Refresh the render before another action. Cancellation responses are never replayed
                automatically.
              </p>
            )}
            {render.errorMessage && (
              <StateMessage
                kind="error"
                description={`${render.errorCode ?? "Render failed"}: ${render.errorMessage}`}
              />
            )}
            <Panel className={styles.preview}>
              <h2>Video preview</h2>
              {render.status === "RUNNING" || render.status === "QUEUED" ? (
                <StateMessage
                  kind="loading"
                  description="The persisted render is still processing. This page refreshes every five seconds."
                />
              ) : expired ? (
                <StateMessage
                  kind="unavailable"
                  description="This render artifact has expired and can no longer be previewed or downloaded."
                />
              ) : render.status === "SUCCEEDED" && video ? (
                <>
                  <MediaPreview
                    label="Rendered vertical video"
                    mediaType={video.mediaType}
                    src={artifactPath(client.workspaceId, render.id, video.id)}
                  />
                  <div className={styles.actions}>
                    <a
                      className="rf-button rf-button--primary"
                      href={artifactPath(client.workspaceId, render.id, video.id, true)}
                    >
                      Download video
                    </a>
                  </div>
                  <p className={styles.meta}>
                    {video.mediaType} · {(video.byteSize / 1_000_000).toFixed(2)} MB
                    {video.retainedUntil
                      ? ` · retained until ${new Date(video.retainedUntil).toLocaleString()}`
                      : ""}
                  </p>
                </>
              ) : (
                <StateMessage
                  kind="error"
                  description="A successful render with a persisted video artifact is required for preview."
                />
              )}
            </Panel>
            {covers.length > 0 && (
              <Panel>
                <h2>Cover artifacts</h2>
                <div className={styles.assetGrid}>
                  {covers.map((cover) => (
                    <article className={styles.asset} key={cover.id}>
                      <MediaPreview
                        label="Render cover"
                        mediaType={cover.mediaType}
                        src={artifactPath(client.workspaceId, render.id, cover.id)}
                      />
                      <a href={artifactPath(client.workspaceId, render.id, cover.id, true)}>
                        Download cover
                      </a>
                    </article>
                  ))}
                </div>
              </Panel>
            )}
          </>
        )}
      </LoadResult>
    </section>
  );
}
