"use client";
import { useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { Badge, Button, Field, Panel, SelectField } from "../../components/ui/primitives";
import { Tabs } from "../../components/ui/tabs";
import { usePlanning, useLoad } from "./session";
import { type IdeaStatus } from "./model";
import { IdeaForm } from "./idea-form";
import { LoadState } from "./common";
import styles from "./planning.module.css";
export function PlanningLibrary(): JSX.Element {
  return (
    <section className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <p className="rf-eyebrow">Creator planning desk</p>
          <h1>Ideas, scripts & storyboard</h1>
          <p>Develop a clear brief, review the words, and plan every scene.</p>
        </div>
      </header>
      <Tabs
        label="Planning libraries"
        items={[
          { id: "ideas", label: "Ideas", content: <Ideas /> },
          { id: "scripts", label: "Scripts & storyboard", content: <Scripts /> },
        ]}
      />
    </section>
  );
}
function Ideas(): JSX.Element {
  const { refresh } = usePlanning();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [archives, setArchives] = useState("active");
  const ideas = useLoad(
    (c) => c.ideas(status ? (status as IdeaStatus) : undefined, archives !== "active"),
    `ideas:${status}:${archives}`,
  );
  const [created, setCreated] = useState("");
  const items = (ideas.data ?? []).filter(
    (i) =>
      (archives !== "archived" || i.archivedAt !== null) &&
      [i.title, i.topic, i.hook, i.angle].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <Field
          id="idea-search"
          label="Search ideas"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Title, topic, hook or angle"
        />
        <SelectField
          id="idea-status"
          label="Idea status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {["DRAFT", "BACKLOG", "APPROVED", "REJECTED", "SCHEDULED"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </SelectField>
        <SelectField
          id="idea-archives"
          label="Archive visibility"
          value={archives}
          onChange={(e) => setArchives(e.target.value)}
        >
          <option value="active">Active ideas</option>
          <option value="all">Active and archived</option>
          <option value="archived">Archived only</option>
        </SelectField>
        <Button tone="secondary" onClick={refresh}>
          Refresh ideas
        </Button>
      </div>
      <LoadState {...ideas} empty={!items.length} />
      <div className={styles.grid}>
        <ul className={styles.list}>
          {items.map((idea) => (
            <li key={idea.id}>
              <StudioLink className={styles.item} href={`/planning/ideas/${idea.id}`}>
                <Badge
                  tone={
                    idea.archivedAt ? "neutral" : idea.status === "APPROVED" ? "success" : "info"
                  }
                >
                  {idea.archivedAt ? "Archived" : idea.status}
                </Badge>
                <h3>{idea.title}</h3>
                <p>{idea.hook}</p>
                <p className={styles.meta}>
                  {idea.topic} · {idea.expectedFormat}
                </p>
              </StudioLink>
            </li>
          ))}
        </ul>
        <div>
          <IdeaForm onSaved={(idea) => setCreated(idea.id)} />
          {created && (
            <p role="status">
              Saved.{" "}
              <StudioLink href={`/planning/ideas/${created}`}>Open the idea brief</StudioLink>
            </p>
          )}
          <Panel>
            <h3>AI discovery is not configured</h3>
            <p>
              No proposal provider is connected by the current server. Search saved ideas or create
              a brief manually.
            </p>
            <Button disabled>Request AI proposals</Button>
          </Panel>
        </div>
      </div>
    </div>
  );
}
function Scripts(): JSX.Element {
  const [page, setPage] = useState(1);
  const state = useLoad((c) => c.scripts(page), `scripts:${page}`);
  return (
    <div className={styles.workspace}>
      <LoadState {...state} empty={!state.data?.items.length} />
      <ul className={styles.list}>
        {state.data?.items.map((script) => (
          <li key={script.id}>
            <StudioLink className={styles.item} href={`/planning/scripts/${script.id}`}>
              <p className={styles.meta}>
                Revision {script.currentRevision} · {script.status}
              </p>
              <h3>{script.revisions[0]?.document.title}</h3>
              <p>{script.revisions[0]?.document.hook}</p>
            </StudioLink>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button tone="secondary" disabled={page === 1} onClick={() => setPage((v) => v - 1)}>
          Previous scripts
        </Button>
        <span>Page {page}</span>
        <Button
          tone="secondary"
          disabled={!state.data?.nextPage}
          onClick={() => setPage(state.data!.nextPage!)}
        >
          Next scripts
        </Button>
      </div>
      <p className={styles.notice}>
        New scripts require an approved idea and a configured M07 provider. Existing scripts can be
        edited without dispatching an AI request.
      </p>
    </div>
  );
}
