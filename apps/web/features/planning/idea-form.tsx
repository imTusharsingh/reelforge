"use client";
import { useEffect, useId, useState, type FormEvent, type JSX } from "react";
import { Alert, Button, Panel, TextAreaField } from "../../components/ui/primitives";
import { requestNavigationIntent, draftEdited } from "../../components/studio-navigation";
import { canWrite, draftFromIdea, PlanningApiError, type Idea, type IdeaDraft } from "./model";
import { usePlanning, useLoad, useDirty, message } from "./session";
import { Choice, json, LoadState } from "./common";
import styles from "./planning.module.css";
const empty: IdeaDraft = {
  title: "",
  topic: "",
  hook: "",
  angle: "",
  audience: "",
  expectedFormat: "short-form-video",
  references: [],
  sourceNotes: "",
  channelId: "",
  seriesId: "",
};
export function IdeaForm({
  idea,
  locked = false,
  onSaved,
}: {
  idea?: Idea;
  locked?: boolean;
  onSaved: (idea: Idea) => void;
}): JSX.Element {
  const { client, suspended, refresh } = usePlanning();
  const baseId = useId();
  const [base, setBase] = useState(idea);
  const [draft, setDraft] = useState<IdeaDraft>(idea ? draftFromIdea(idea) : { ...empty });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const channels = useLoad((c) => c.objects("channels"), "channels");
  const series = useLoad(
    (c) =>
      draft.channelId
        ? c.objects(`channels/${encodeURIComponent(draft.channelId)}/series`)
        : Promise.resolve([]),
    `series:${draft.channelId}`,
  );
  useEffect(() => {
    if (!dirty && (!idea || !base || idea.updatedAt >= base.updatedAt)) {
      setBase(idea);
      if (idea) setDraft(draftFromIdea(idea));
    } else if (idea && idea.updatedAt !== base?.updatedAt) setConflict(true);
  }, [idea, dirty, base?.updatedAt]);
  const discard = (): void => {
    setDraft(base ? draftFromIdea(base) : { ...empty });
    setDirty(false);
  };
  useDirty(baseId, dirty, discard);
  const editable = canWrite(client.role) && !suspended && !locked && !busy;
  const edit = <K extends keyof IdeaDraft>(key: K, value: IdeaDraft[K]): void => {
    setDraft((v) => ({ ...v, [key]: value }));
    setDirty(true);
    draftEdited();
    setNotice("");
  };
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editable || conflict) return;
    setBusy(true);
    setError("");
    try {
      const saved = base ? await client.editIdea(base, draft) : await client.createIdea(draft);
      if (client.signal.aborted) return;
      setBase(idea ? saved : undefined);
      setDraft(idea ? draftFromIdea(saved) : { ...empty });
      setDirty(false);
      setNotice("Idea saved by the server.");
      onSaved(saved);
      refresh();
    } catch (cause) {
      if (client.signal.aborted) return;
      setError(message(cause));
      if (cause instanceof PlanningApiError && cause.status === 409) setConflict(true);
      refresh();
    } finally {
      if (!client.signal.aborted) setBusy(false);
    }
  };
  return (
    <Panel>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!editable}>
          <legend>{idea ? "Idea brief" : "Create an idea"}</legend>
          {(
            [
              ["title", "Title"],
              ["topic", "Topic"],
              ["hook", "Opening hook"],
              ["angle", "Editorial angle"],
              ["audience", "Audience"],
              ["expectedFormat", "Expected format"],
            ] as const
          ).map(([key, label]) => (
            <TextAreaField
              key={key}
              id={`${baseId}-${key}`}
              label={label}
              value={draft[key]}
              onChange={(e) => edit(key, e.target.value)}
              rows={key === "title" || key === "expectedFormat" ? 1 : 3}
              maxLength={
                key === "title"
                  ? 240
                  : key === "audience"
                    ? 500
                    : key === "expectedFormat"
                      ? 200
                      : 2000
              }
              required
            />
          ))}
          <LoadState {...channels} />
          <Choice
            label="Idea channel"
            items={channels.data ?? []}
            value={draft.channelId}
            onChange={(v) => {
              edit("channelId", v);
              edit("seriesId", "");
            }}
          />
          <LoadState {...series} />
          <Choice
            label="Idea series (optional)"
            items={series.data ?? []}
            value={draft.seriesId}
            onChange={(v) => edit("seriesId", v)}
            emptyLabel="No series"
          />
          <TextAreaField
            id={`${baseId}-sources`}
            label="References — one per line"
            value={draft.references.join("\n")}
            onChange={(e) => edit("references", e.target.value.split("\n"))}
            rows={3}
            hint="Sources are retained with an approved idea snapshot."
          />
          <TextAreaField
            id={`${baseId}-notes`}
            label="Source notes"
            value={draft.sourceNotes}
            onChange={(e) => edit("sourceNotes", e.target.value)}
            maxLength={5000}
            rows={4}
          />
        </fieldset>
        {dirty && <p role="status">Unsaved idea changes</p>}
        {locked && (
          <p className={styles.notice}>
            Approved or historically approved ideas cannot be edited or archived. Their snapshots
            remain immutable.
          </p>
        )}
        {error && (
          <Alert tone="danger" title="Idea not saved">
            {error}
          </Alert>
        )}
        {notice && <p role="status">{notice}</p>}
        {conflict && (
          <Alert tone="warning" title="Compare a newer saved brief">
            Your draft is preserved. Refresh before choosing which values to keep.
            <Button onClick={refresh}>Fetch latest brief</Button>
            {idea && (
              <div className={styles.compare}>
                <pre className={styles.inspect}>{json(draft)}</pre>
                <pre className={styles.inspect}>{json(draftFromIdea(idea))}</pre>
              </div>
            )}
            <div className={styles.actions}>
              <Button
                tone="secondary"
                onClick={() => {
                  if (idea && requestNavigationIntent("selection")) {
                    setBase(idea);
                    setDraft(draftFromIdea(idea));
                    setDirty(false);
                    setConflict(false);
                    setError("");
                  }
                }}
              >
                Use saved brief
              </Button>
              <Button
                tone="secondary"
                disabled={!idea || idea.updatedAt === base?.updatedAt}
                onClick={() => {
                  if (
                    idea &&
                    window.confirm("Use your draft with the displayed latest concurrency token?")
                  ) {
                    setBase(idea);
                    setConflict(false);
                  }
                }}
              >
                Keep my draft against latest brief
              </Button>
            </div>
          </Alert>
        )}
        <Button type="submit" disabled={!editable || conflict} loading={busy}>
          {idea ? "Save brief" : "Create idea"}
        </Button>
      </form>
    </Panel>
  );
}
