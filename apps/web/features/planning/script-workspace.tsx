"use client";
import { useEffect, useId, useState, type JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { requestNavigationIntent, draftEdited } from "../../components/studio-navigation";
import { Alert, Badge, Button, Field, Panel, TextAreaField } from "../../components/ui/primitives";
import {
  canWrite,
  mergeRevision,
  moveScene,
  normalizeSceneTimings,
  patchScene,
  validateDocument,
  PlanningApiError,
  type Script,
  type ScriptDocument,
  type Scene,
  type Revision,
} from "./model";
import { usePlanning, useLoad, useDirty, message } from "./session";
import { Choice, json, LoadState } from "./common";
import styles from "./planning.module.css";
export function ScriptWorkspace({ scriptId }: { scriptId: string }): JSX.Element {
  const state = useLoad((c) => c.script(scriptId), `script:${scriptId}`);
  return (
    <section className={styles.workspace}>
      <StudioLink href="/planning">← Back to planning</StudioLink>
      <LoadState {...state} />
      {state.data && <ScriptEditor key={state.data.id} script={state.data} />}
    </section>
  );
}
export function ScriptEditor({ script }: { script: Script }): JSX.Element {
  const { client, suspended, refresh } = usePlanning();
  const id = useId();
  const [base, setBase] = useState(script);
  const [draft, setDraft] = useState<ScriptDocument>(() =>
    structuredClone(script.revisions[0]!.document),
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remote, setRemote] = useState<Script | null>(null);
  const [selected, setSelected] = useState(draft.scenes[0]!.id);
  const [historical, setHistorical] = useState<Revision | null>(null);
  const [page, setPage] = useState(1);
  const history = useLoad((c) => c.history(script.id, page), `history:${script.id}:${page}`);
  useEffect(() => {
    if (!dirty && script.currentRevision >= base.currentRevision) {
      setBase(script);
      setDraft(structuredClone(script.revisions[0]!.document));
    } else if (dirty && script.currentRevision > base.currentRevision) setRemote(script);
  }, [script, dirty, base.currentRevision]);
  useDirty(id, dirty, () => {
    setDraft(structuredClone(base.revisions[0]!.document));
    setDirty(false);
  });
  const readonly =
    !canWrite(client.role) ||
    suspended ||
    base.status === "APPROVED" ||
    busy ||
    Boolean(historical);
  const visible = historical?.document ?? draft;
  const scene = visible.scenes.find((s) => s.id === selected) ?? visible.scenes[0]!;
  const validation = validateDocument(draft);
  const change = (next: ScriptDocument): void => {
    setDraft(next);
    setDirty(true);
    draftEdited();
    setNotice("");
  };
  const editScene = (patch: Partial<Scene>): void => change(patchScene(draft, scene.id, patch));
  const fetchRemote = async (): Promise<void> => {
    try {
      const latest = await client.script(base.id);
      if (!client.signal.aborted) setRemote(latest);
    } catch (e) {
      if (!client.signal.aborted) setError(message(e));
    }
  };
  const save = async (): Promise<void> => {
    if (readonly || validation || remote) return;
    setBusy(true);
    setError("");
    try {
      const saved = await client.reviseScript(base, draft);
      if (client.signal.aborted) return;
      setBase(saved);
      setDraft(structuredClone(saved.revisions[0]!.document));
      setDirty(false);
      setNotice(`Revision ${saved.currentRevision} saved by the server.`);
      refresh();
    } catch (e) {
      if (client.signal.aborted) return;
      setError(message(e));
      if (e instanceof PlanningApiError && e.status === 409) await fetchRemote();
      refresh();
    } finally {
      if (!client.signal.aborted) setBusy(false);
    }
  };
  const approve = async (): Promise<void> => {
    if (
      readonly ||
      dirty ||
      remote ||
      !window.confirm(
        "Approve the current persisted script revision? Approved scripts cannot be edited.",
      )
    )
      return;
    setBusy(true);
    try {
      const saved = await client.approveScript(base);
      if (!client.signal.aborted) {
        setBase(saved);
        setNotice("Script approved by the server.");
        refresh();
      }
    } catch (e) {
      if (!client.signal.aborted) {
        setError(message(e));
        await fetchRemote();
        refresh();
      }
    } finally {
      if (!client.signal.aborted) setBusy(false);
    }
  };
  const total = draft.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  return (
    <>
      <header className={styles.header}>
        <div>
          <p className="rf-eyebrow">Script & storyboard</p>
          <h1>{visible.title}</h1>
          <Badge tone={base.status === "APPROVED" ? "success" : "info"}>{base.status}</Badge>
          <p className={styles.meta}>
            Persisted revision {base.currentRevision}
            {historical
              ? ` · Inspecting history revision ${historical.revision}`
              : " · Working draft"}
          </p>
        </div>
        <div className={styles.actions}>
          <Button tone="secondary" onClick={() => void fetchRemote()}>
            Fetch latest for comparison
          </Button>
          <Button
            onClick={() => void save()}
            disabled={readonly || !dirty || Boolean(validation) || Boolean(remote)}
            loading={busy}
          >
            Save script revision
          </Button>
          <Button
            tone="secondary"
            onClick={() => void approve()}
            disabled={readonly || dirty || Boolean(remote)}
          >
            Approve saved script
          </Button>
        </div>
      </header>
      {dirty && <p role="status">Unsaved script changes</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <Alert tone="danger" title="Script action failed">
          {error}
        </Alert>
      )}
      {base.status === "APPROVED" && (
        <Alert title="Immutable approved script" tone="info">
          This approved revision is read-only.
        </Alert>
      )}
      {remote && (
        <Alert tone="warning" title="Compare server and working draft">
          <p>Your draft has been preserved. No automatic overwrite or retry was performed.</p>
          <div className={styles.compare}>
            <pre className={styles.inspect}>{json(draft)}</pre>
            <pre className={styles.inspect}>{json(remote.revisions[0]!.document)}</pre>
          </div>
          <div className={styles.actions}>
            <Button
              tone="secondary"
              onClick={() => {
                if (requestNavigationIntent("selection")) {
                  setBase(remote);
                  setDraft(structuredClone(remote.revisions[0]!.document));
                  setRemote(null);
                  setDirty(false);
                }
              }}
            >
              Use latest saved revision
            </Button>
            <Button
              tone="secondary"
              disabled={remote.status === "APPROVED"}
              onClick={() => {
                try {
                  const merged = mergeRevision(
                    base.revisions[0]!.document,
                    draft,
                    remote.revisions[0]!.document,
                  );
                  setBase(remote);
                  setDraft(merged);
                  setRemote(null);
                  setDirty(true);
                  draftEdited();
                  setNotice(
                    "Non-conflicting edits rebased. Inspect and explicitly save a new revision.",
                  );
                } catch (e) {
                  setError(message(e));
                }
              }}
            >
              Rebase non-conflicting edits
            </Button>
          </div>
        </Alert>
      )}
      <div className={styles.grid}>
        <Panel>
          <h2>Script text</h2>
          <fieldset className={styles.form} disabled={readonly}>
            {(
              [
                ["title", "Script title"],
                ["hook", "Script hook"],
                ["dialogue", "Full dialogue"],
                ["narration", "Full narration"],
                ["cta", "Call to action"],
              ] as const
            ).map(([key, label]) => (
              <TextAreaField
                key={key}
                id={`${id}-${key}`}
                label={label}
                value={visible[key] ?? ""}
                onChange={(e) => change({ ...draft, [key]: e.target.value })}
                rows={key === "dialogue" || key === "narration" ? 5 : 2}
              />
            ))}
            <Field
              id={`${id}-genre`}
              label="Genre name"
              value={visible.metadata.genre}
              onChange={(e) =>
                change({ ...draft, metadata: { ...draft.metadata, genre: e.target.value } })
              }
              hint="Choose a genre configured in this workspace. Its factuality policy will be checked on save."
            />
            <Field
              id={`${id}-duration`}
              label="Target duration (seconds)"
              type="number"
              min={0.1}
              step="any"
              value={visible.metadata.targetDurationSeconds}
              onChange={(e) =>
                change({
                  ...draft,
                  metadata: { ...draft.metadata, targetDurationSeconds: Number(e.target.value) },
                })
              }
            />
            <label>
              <input
                type="checkbox"
                checked={visible.metadata.factual}
                onChange={(e) =>
                  change({ ...draft, metadata: { ...draft.metadata, factual: e.target.checked } })
                }
              />{" "}
              Contains factual claims
            </label>
          </fieldset>
          <Claims document={visible} disabled={readonly} onChange={change} />
        </Panel>
        <Panel>
          <h2>Persisted revision history</h2>
          <LoadState {...history} empty={!history.data?.items.length} />
          <ol className={styles.list}>
            {history.data?.items.map((revision) => (
              <li key={revision.revision}>
                <Button
                  tone="secondary"
                  onClick={() => {
                    if (requestNavigationIntent("selection")) {
                      setHistorical(revision);
                      setSelected(revision.document.scenes[0]!.id);
                    }
                  }}
                >
                  Inspect revision {revision.revision}
                </Button>
                <p className={styles.meta}>
                  {revision.createdAt
                    ? new Date(revision.createdAt).toLocaleString()
                    : "Timestamp unavailable"}
                  {revision.modelVersion ? ` · ${revision.modelVersion}` : " · Manual revision"}
                </p>
              </li>
            ))}
          </ol>
          <div className={styles.actions}>
            <Button disabled={page === 1} tone="secondary" onClick={() => setPage((v) => v - 1)}>
              Previous history
            </Button>
            <span>Page {page}</span>
            <Button
              disabled={!history.data?.nextPage}
              tone="secondary"
              onClick={() => setPage(history.data!.nextPage!)}
            >
              Next history
            </Button>
          </div>
          {historical && (
            <>
              <Button tone="secondary" onClick={() => setHistorical(null)}>
                Return to current draft
              </Button>
              <Button
                disabled={!canWrite(client.role) || suspended || base.status === "APPROVED"}
                onClick={() => {
                  setDraft(structuredClone(historical.document));
                  setHistorical(null);
                  setDirty(true);
                  draftEdited();
                }}
              >
                Use inspected revision as a new draft
              </Button>
            </>
          )}
        </Panel>
      </div>
      <section>
        <div className={styles.header}>
          <div>
            <h2>Storyboard</h2>
            <p>
              {visible.scenes.length} scenes ·{" "}
              {visible.scenes.reduce((sum, s) => sum + s.durationSeconds, 0)} seconds
            </p>
          </div>
          <div className={styles.actions}>
            <Button
              tone="secondary"
              disabled={readonly}
              onClick={() => change({ ...draft, scenes: normalizeSceneTimings(draft.scenes) })}
            >
              Reflow scene starts
            </Button>
            <Button
              tone="secondary"
              disabled={readonly || !Number.isFinite(total) || total <= 0}
              onClick={() =>
                change({ ...draft, metadata: { ...draft.metadata, targetDurationSeconds: total } })
              }
            >
              Use scene total as target
            </Button>
          </div>
        </div>
        <nav className={styles.timeline} aria-label="Storyboard scene selection">
          {visible.scenes.map((s, index) => (
            <button
              key={s.id}
              aria-pressed={s.id === scene.id}
              aria-label={`Scene ${index + 1} · ${s.durationSeconds}s`}
              onClick={() => {
                setSelected(s.id);
                document.getElementById(`${id}-scene`)?.focus();
              }}
            >
              <span className={styles.sceneNumber}>
                Scene {index + 1} · {s.startSeconds}–{s.startSeconds + s.durationSeconds}s
              </span>
              <strong>{s.visualDescription}</strong>
              <span>
                {s.camera} · {s.durationSeconds}s
              </span>
            </button>
          ))}
        </nav>
        {validation && !historical && (
          <Alert tone="warning" title="Duration or document validation">
            {validation}
          </Alert>
        )}
        <div className={styles.scene} id={`${id}-scene`} tabIndex={-1}>
          <div className={styles.sceneHeader}>
            <h3>Scene {visible.scenes.findIndex((s) => s.id === scene.id) + 1}</h3>
            <span className={styles.sceneNumber}>{scene.id}</span>
            <div className={styles.actions}>
              <Button
                tone="secondary"
                disabled={readonly || draft.scenes[0]?.id === scene.id}
                onClick={() => change(moveScene(draft, scene.id, -1))}
              >
                Move scene earlier
              </Button>
              <Button
                tone="secondary"
                disabled={readonly || draft.scenes.at(-1)?.id === scene.id}
                onClick={() => change(moveScene(draft, scene.id, 1))}
              >
                Move scene later
              </Button>
            </div>
          </div>
          <fieldset className={styles.form} disabled={readonly}>
            <div className={styles.toolbar}>
              <Field
                id={`${id}-start`}
                label="Scene start (seconds)"
                type="number"
                min={0}
                step="any"
                value={scene.startSeconds}
                onChange={(e) => editScene({ startSeconds: Number(e.target.value) })}
              />
              <Field
                id={`${id}-length`}
                label="Scene duration (seconds)"
                type="number"
                min={0.1}
                step="any"
                value={scene.durationSeconds}
                onChange={(e) => editScene({ durationSeconds: Number(e.target.value) })}
              />
            </div>
            {(
              [
                ["visualDescription", "Visual direction"],
                ["camera", "Camera direction"],
                ["dialogue", "Scene dialogue"],
                ["narration", "Scene narration"],
                ["transition", "Transition"],
              ] as const
            ).map(([key, label]) => (
              <TextAreaField
                key={key}
                id={`${id}-scene-${key}`}
                label={label}
                value={scene[key] ?? ""}
                onChange={(e) => editScene({ [key]: e.target.value })}
                rows={3}
              />
            ))}
            <TextAreaField
              id={`${id}-cues`}
              label="Audio cues — one per line"
              value={scene.audioCues.join("\n")}
              onChange={(e) => editScene({ audioCues: e.target.value.split("\n") })}
            />
          </fieldset>
          <CharacterAssignments
            scene={scene}
            disabled={readonly}
            onChange={(refs) => editScene({ characterRefs: refs })}
          />
          <p className={styles.notice}>
            Scene asset assignment is not available in planning yet. Character versions are saved
            with each scene; media assets are assigned later in production.
          </p>
          <Button disabled>Assign scene asset — unavailable</Button>
        </div>
      </section>
    </>
  );
}
function Claims({
  document,
  disabled,
  onChange,
}: {
  document: ScriptDocument;
  disabled: boolean;
  onChange: (v: ScriptDocument) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className={styles.form}>
      <h3>Source-backed claims</h3>
      {document.claims?.map((claim, index) => (
        <div className={styles.toolbar} key={index}>
          <Field
            id={`${id}-${index}-text`}
            label={`Claim ${index + 1}`}
            value={claim.text}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...document,
                claims: (document.claims ?? []).map((c, i) =>
                  i === index ? { ...c, text: e.target.value } : c,
                ),
              })
            }
          />
          <Field
            id={`${id}-${index}-url`}
            label={`Claim ${index + 1} source URL`}
            type="url"
            value={claim.sourceUrl}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...document,
                claims: (document.claims ?? []).map((c, i) =>
                  i === index ? { ...c, sourceUrl: e.target.value } : c,
                ),
              })
            }
          />
          <Button
            disabled={disabled}
            tone="ghost"
            onClick={() =>
              onChange({
                ...document,
                claims: (document.claims ?? []).filter((_, i) => i !== index),
              })
            }
          >
            Remove claim {index + 1}
          </Button>
        </div>
      ))}
      <Button
        disabled={disabled}
        tone="secondary"
        onClick={() =>
          onChange({
            ...document,
            claims: [...(document.claims ?? []), { text: "", sourceUrl: "" }],
          })
        }
      >
        Add factual claim
      </Button>
      <p className={styles.meta}>
        Claims must follow the genre policy and cite sources from the approved idea brief.
      </p>
    </div>
  );
}
function CharacterAssignments({
  scene,
  disabled,
  onChange,
}: {
  scene: Scene;
  disabled: boolean;
  onChange: (refs: Scene["characterRefs"]) => void;
}): JSX.Element {
  const [character, setCharacter] = useState("");
  const [version, setVersion] = useState("");
  const characters = useLoad((c) => c.objects("characters"), "planning-characters");
  const versions = useLoad(
    (c) =>
      character
        ? c.objects(`characters/${encodeURIComponent(character)}/versions`)
        : Promise.resolve([]),
    `planning-versions:${character}`,
  );
  const available = (versions.data ?? []).filter(
    (v) => v.status === "PUBLISHED" && v.characterId === character,
  );
  return (
    <Panel>
      <h3>Pinned character versions</h3>
      <ul>
        {scene.characterRefs.map((ref) => (
          <li key={`${ref.characterId}:${ref.versionId}`}>
            <span className={styles.meta}>
              {(characters.data?.find((c) => c.id === ref.characterId)?.name as string) ??
                ref.characterId}{" "}
              · {ref.versionId}
            </span>
            <Button
              disabled={disabled}
              tone="ghost"
              onClick={() => onChange(scene.characterRefs.filter((r) => r !== ref))}
            >
              Remove character reference
            </Button>
          </li>
        ))}
      </ul>
      <LoadState {...characters} />
      <Choice
        label="Scene character"
        items={characters.data ?? []}
        value={character}
        onChange={(v) => {
          setCharacter(v);
          setVersion("");
        }}
        disabled={disabled}
      />
      <LoadState {...versions} />
      <Choice
        label="Published scene character version"
        items={available}
        value={version}
        onChange={setVersion}
        disabled={disabled}
      />
      <Button
        disabled={
          disabled ||
          !available.some((v) => v.id === version) ||
          scene.characterRefs.some((r) => r.versionId === version)
        }
        onClick={() =>
          onChange([...scene.characterRefs, { characterId: character, versionId: version }])
        }
      >
        Assign published character
      </Button>
    </Panel>
  );
}
