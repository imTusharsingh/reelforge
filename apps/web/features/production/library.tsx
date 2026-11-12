"use client";
import { useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { Badge, Button } from "../../components/ui/primitives";
import { Tabs } from "../../components/ui/tabs";
import { LoadResult } from "./common";
import { statusTone } from "./model";
import styles from "./production.module.css";
import { useLoad, useProduction } from "./session";

export function ProductionLibrary(): JSX.Element {
  return (
    <section className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <p className="rf-eyebrow">Generation studio</p>
          <h1>Production projects</h1>
          <p>Inspect scene media, provider readiness, render progress and finished exports.</p>
        </div>
      </header>
      <Tabs
        label="Production libraries"
        items={[
          { id: "projects", label: "Scene projects", content: <Projects /> },
          { id: "ready", label: "Approved scripts", content: <ApprovedScripts /> },
          { id: "renders", label: "Render history", content: <Renders /> },
        ]}
      />
    </section>
  );
}

function Projects(): JSX.Element {
  const { refresh } = useProduction();
  const [page, setPage] = useState(1);
  const state = useLoad((client) => client.sceneJobs(page), `scene-jobs:${page}`);
  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <Button tone="secondary" onClick={refresh}>
          Refresh projects
        </Button>
      </div>
      <LoadResult state={state} empty={!state.data?.items.length} onRetry={refresh}>
        <ul className={styles.list}>
          {state.data?.items.map((job) => (
            <li key={job.jobId}>
              <StudioLink className={styles.card} href={`/production/jobs/${job.jobId}`}>
                <span className={styles.cardHead}>
                  <span>
                    <span className="rf-eyebrow">Script revision {job.scriptRevision}</span>
                    <h3>Production {job.jobId.slice(0, 8)}</h3>
                  </span>
                  <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                </span>
                <span className={styles.meta}>
                  {job.requestedOutputs.video ? "Motion" : "Still image"} ·{" "}
                  {job.requestedOutputs.narration ? "Narration" : "No narration"} · Updated{" "}
                  {new Date(job.updatedAt).toLocaleString()}
                </span>
              </StudioLink>
            </li>
          ))}
        </ul>
      </LoadResult>
      <Pagination page={page} next={state.data?.nextPage ?? null} setPage={setPage} />
    </div>
  );
}

function ApprovedScripts(): JSX.Element {
  const { refresh } = useProduction();
  const [page, setPage] = useState(1);
  const state = useLoad((client) => client.scripts(page), `production-scripts:${page}`);
  const scripts = state.data?.items.filter((script) => script.status === "APPROVED") ?? [];
  return (
    <div className={styles.workspace}>
      <LoadResult state={state} empty={!scripts.length} onRetry={refresh}>
        <ul className={styles.list}>
          {scripts.map((script) => (
            <li key={script.id}>
              <StudioLink className={styles.card} href={`/production/scripts/${script.id}`}>
                <span className={styles.cardHead}>
                  <span>
                    <span className="rf-eyebrow">Approved revision {script.currentRevision}</span>
                    <h3>{script.revisions[0]?.document.title}</h3>
                  </span>
                  <Badge tone="success">Ready for production</Badge>
                </span>
                <span>{script.revisions[0]?.document.hook}</span>
              </StudioLink>
            </li>
          ))}
        </ul>
      </LoadResult>
      <Pagination page={page} next={state.data?.nextPage ?? null} setPage={setPage} />
    </div>
  );
}

function Renders(): JSX.Element {
  const { refresh } = useProduction();
  const [page, setPage] = useState(1);
  const state = useLoad((client) => client.renders(page), `renders:${page}`);
  return (
    <div className={styles.workspace}>
      <LoadResult state={state} empty={!state.data?.items.length} onRetry={refresh}>
        <ul className={styles.list}>
          {state.data?.items.map((render) => (
            <li key={render.jobId}>
              <StudioLink className={styles.card} href={`/production/renders/${render.jobId}`}>
                <span className={styles.cardHead}>
                  <span>
                    <span className="rf-eyebrow">Render attempt {render.attempt}</span>
                    <h3>Export {render.jobId.slice(0, 8)}</h3>
                  </span>
                  <Badge tone={statusTone(render.status)}>{render.status}</Badge>
                </span>
                <span className={styles.meta}>
                  {render.artifactCount} artifact{render.artifactCount === 1 ? "" : "s"} ·{" "}
                  {new Date(render.updatedAt).toLocaleString()}
                </span>
              </StudioLink>
            </li>
          ))}
        </ul>
      </LoadResult>
      <Pagination page={page} next={state.data?.nextPage ?? null} setPage={setPage} />
    </div>
  );
}

function Pagination({
  page,
  next,
  setPage,
}: {
  page: number;
  next: number | null;
  setPage: (page: number) => void;
}): JSX.Element {
  return (
    <div className={styles.actions}>
      <Button tone="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
        Previous
      </Button>
      <span>Page {page}</span>
      <Button tone="secondary" disabled={next === null} onClick={() => next && setPage(next)}>
        Next
      </Button>
    </div>
  );
}
