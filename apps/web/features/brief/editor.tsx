"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import {
  BriefInputSchema,
  StoredBriefInputShape,
  defaultBrief,
  type BriefInput,
} from "../../../../packages/contracts/src/channel-brief";
import { ProductionFields } from "./production-fields";
import { Alert, Button, Panel, StateMessage } from "../../components/ui/primitives";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { draftEdited, registerDraft } from "../../components/studio-navigation";
import { ensureCsrfToken } from "../../lib/csrf";
import { BriefClient } from "./client";
import { IdentityFields, JsonField, ScheduleBudget, StyleFields } from "./fields";

const seed = (): BriefInput =>
  defaultBrief({
    niche: "My channel",
    audience: "General audience",
    language: "English",
    voiceId: "Kore",
    cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
  });
export function BriefEditor({ channelId }: { channelId: string }): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <Editor
      key={`${workspace.id}:${workspace.role}:${channelId}`}
      workspaceId={workspace.id}
      channelId={channelId}
      editable={workspace.role !== "VIEWER"}
    />
  );
}
function Editor({
  workspaceId,
  channelId,
  editable,
}: {
  workspaceId: string;
  channelId: string;
  editable: boolean;
}): JSX.Element {
  const state = useEditorState({ workspaceId, channelId, editable });
  return <EditorView {...state} />;
}
type EditorState = {
  channelId: string;
  editable: boolean;
  value: BriefInput;
  setValue: (value: BriefInput) => void;
  version: number;
  offerL3: boolean;
  loaded: boolean;
  message: string;
  error: string;
  busy: boolean;
  discard: () => void;
  formVersion: number;
  submit: (event: FormEvent) => Promise<void>;
};
type EditorScope = { workspaceId: string; channelId: string; editable: boolean };
function useEditorState({ workspaceId, channelId, editable }: EditorScope): EditorState {
  const { value, edit, accept, reset } = useBriefDraft(channelId);
  const [formVersion, setFormVersion] = useState(0);
  const [version, setVersion] = useState(0);
  const [offerL3, setOfferL3] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEditorLoad(workspaceId, channelId, accept, setVersion, setOfferL3, setLoaded, setError);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await ensureCsrfToken();
      const saved = await new BriefClient(workspaceId).save(
        channelId,
        BriefInputSchema.parse(value),
      );
      accept(value);
      setVersion(saved.version);
      setMessage(`Saved immutable Brief version ${saved.version}.`);
    } catch {
      setError(
        "Brief was not saved. Check the fields and reload if another editor saved a version.",
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    channelId,
    editable,
    value,
    setValue: edit,
    formVersion,
    discard: (): void => {
      reset();
      setFormVersion((v) => v + 1);
      setMessage("");
      setError("");
    },
    version,
    offerL3,
    loaded,
    message,
    error,
    busy,
    submit,
  };
}
function useBriefDraft(channelId: string): {
  value: BriefInput;
  edit: (value: BriefInput) => void;
  reset: () => void;
  accept: (value: BriefInput) => void;
} {
  const [value, setValue] = useState<BriefInput>(seed);
  const [dirty, setDirty] = useState(false);
  const saved = useRef(value);
  const accept = useCallback((next: BriefInput): void => {
    saved.current = next;
    setValue(next);
    setDirty(false);
  }, []);
  const edit = (next: BriefInput): void => {
    draftEdited();
    setDirty(true);
    setValue(next);
  };
  useEffect(() => {
    if (!dirty) return;
    return registerDraft(`brief:${channelId}`, () => accept(saved.current));
  }, [accept, channelId, dirty]);
  return { value, edit, accept, reset: () => accept(saved.current) };
}
function EditorView({
  editable,
  value,
  setValue,
  version,
  offerL3,
  loaded,
  message,
  error,
  busy,
  submit,
  discard,
  formVersion,
}: ReturnType<typeof useEditorState>): JSX.Element {
  return (
    <Panel>
      <h2>Channel Brief</h2>
      <p>Version {version}. Edits create a new immutable version.</p>
      {error && (
        <Alert tone="danger" title="Brief needs attention">
          {error}
        </Alert>
      )}
      {message && <StateMessage kind="success" description={message} />}
      {!loaded && !error ? (
        <StateMessage kind="loading" description="Loading Brief…" />
      ) : loaded ? (
        <form key={formVersion} onSubmit={submit} className="rf-form">
          <fieldset disabled={!editable || busy}>
            <legend>{editable ? "Edit your Brief" : "Read-only Brief"}</legend>
            <IdentityFields value={value} onChange={setValue} offerL3={offerL3} />
            <ScheduleBudget value={value} onChange={setValue} />
            <StyleFields value={value} onChange={setValue} />
            <DetailedFields value={value} onChange={setValue} />
            <Button tone="secondary" onClick={discard}>
              Discard changes
            </Button>
            <Button type="submit" loading={busy}>
              Save new version
            </Button>
          </fieldset>
        </form>
      ) : null}
    </Panel>
  );
}
function DetailedFields({
  value,
  onChange,
}: {
  value: BriefInput;
  onChange: (value: BriefInput) => void;
}): JSX.Element {
  const fields = ["onCameraVoice", "tuningBounds", "references", "referenceDefaults"] as const;
  return (
    <>
      <h2>Voice, formats and references</h2>
      <ProductionFields value={value} onChange={onChange} />
      <details>
        <summary>Advanced reference and tuning settings</summary>
        <p>
          Reference pins use an asset ID and immutable version. No recurring characters is the
          default. Null tuning bounds keep learning recommendations only.
        </p>
        {fields.map((key) => (
          <JsonField
            key={key}
            label={key}
            value={value[key]}
            onChange={(next) => onChange({ ...value, [key]: next } as BriefInput)}
          />
        ))}
        <JsonField
          label="recurringCharacters"
          value={value.styleBible.recurringCharacters}
          onChange={(next) =>
            onChange({
              ...value,
              styleBible: {
                ...value.styleBible,
                recurringCharacters: next as BriefInput["styleBible"]["recurringCharacters"],
              },
            })
          }
        />
        <Advanced value={value} onChange={onChange} />
      </details>
    </>
  );
}

function Advanced({
  value,
  onChange,
}: {
  value: BriefInput;
  onChange: (value: BriefInput) => void;
}): JSX.Element {
  return (
    <details>
      <summary>Advanced</summary>
      <JsonField
        label="constraints"
        value={value.constraints}
        onChange={(next) => onChange({ ...value, constraints: next as BriefInput["constraints"] })}
      />
    </details>
  );
}

function useEditorLoad(
  workspaceId: string,
  channelId: string,
  setValue: (v: BriefInput) => void,
  setVersion: (v: number) => void,
  setOfferL3: (v: boolean) => void,
  setLoaded: (v: boolean) => void,
  setError: (v: string) => void,
): void {
  useEffect(() => {
    let active = true;
    const client = new BriefClient(workspaceId);
    void Promise.all([client.briefs(channelId), client.eligibility(channelId)])
      .then(([briefs, eligible]) => {
        if (!active) return;
        const latest = briefs[0];
        if (latest) {
          const input = Object.fromEntries(
            Object.entries(latest).filter(
              ([key]) =>
                !["id", "workspaceId", "channelId", "version", "schemaVersion"].includes(key),
            ),
          );
          setValue(StoredBriefInputShape.parse(input));
          setVersion(latest.version);
        }
        setOfferL3(eligible);
        setLoaded(true);
      })
      .catch(() => {
        if (active) setError("Unable to load this channel Brief.");
      });
    return (): void => {
      active = false;
    };
  }, [workspaceId, channelId]);
}
