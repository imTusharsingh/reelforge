"use client";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Alert,
  Button,
  Field,
  Panel,
  SelectField,
  StateMessage,
  TextAreaField,
} from "../../components/ui/primitives";
import { ChannelsClient, ChannelApiError, type Shape } from "./api";
import {
  canEdit,
  channelPayload,
  formPayload,
  pretty,
  text,
  type FieldSpec,
  type RecordValue,
} from "./model";

const ClientContext = createContext<ChannelsClient | null>(null);
const DirtyContext = createContext<RefObject<Set<string>> | null>(null);
export function ChannelsScope({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}): JSX.Element {
  const [client, setClient] = useState<ChannelsClient | null>(null);
  const dirtyForms = useRef(new Set<string>());
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent): void => {
      if (dirtyForms.current.size) event.preventDefault();
    };
    const navigate = (event: MouseEvent): void => {
      if (!dirtyForms.current.size) return;
      const target =
        event.target instanceof Element ? event.target.closest("a[href], button") : null;
      if (
        target &&
        (target.matches("a[href]") ||
          ["Switch workspace", "Sign out"].includes(target.textContent?.trim() ?? "")) &&
        !window.confirm("Discard unsaved changes?")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return (): void => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const next = new ChannelsClient(workspaceId, controller.signal);
    setClient(next);
    return (): void => controller.abort();
  }, [workspaceId]);
  if (!client || client.workspaceId !== workspaceId)
    return <StateMessage kind="loading" description="Loading workspace context…" />;
  return (
    <ClientContext.Provider value={client}>
      <DirtyContext.Provider value={dirtyForms}>{children}</DirtyContext.Provider>
    </ClientContext.Provider>
  );
}
export function useChannelsClient(): ChannelsClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("Channels require the authenticated workspace context.");
  return client;
}
export function useResource(
  path: string,
  list = true,
  shape: Shape = "named",
  revision = 0,
): { data: RecordValue[]; error: string; loading: boolean } {
  const client = useChannelsClient();
  const [state, setState] = useState({ data: [] as RecordValue[], error: "", loading: true });
  useEffect(() => {
    const controller = new AbortController();
    const scoped = new ChannelsClient(
      client.workspaceId,
      AbortSignal.any([controller.signal, client.signal]),
      client.role,
    );
    setState({ data: [], error: "", loading: true });
    void (list ? scoped.list(path, shape) : scoped.get(path, shape).then((v) => [v]))
      .then((data) => {
        if (!scoped.signal.aborted) setState({ data, error: "", loading: false });
      })
      .catch((e: unknown) => {
        if (!scoped.signal.aborted) setState({ data: [], error: failure(e), loading: false });
      });
    return (): void => controller.abort();
  }, [client, path, list, shape, revision]);
  return state;
}
export function failure(e: unknown): string {
  return e instanceof Error ? e.message : "The request failed. Please try again.";
}
export function ResourceState({
  loading,
  error,
  empty,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
}): JSX.Element | null {
  if (loading) return <StateMessage kind="loading" description="Loading saved data…" />;
  if (error)
    return (
      <Alert tone="danger" title="Data unavailable">
        {error}
      </Alert>
    );
  if (empty) return <StateMessage kind="empty" description="No saved items yet." />;
  return null;
}
export function SavedData({
  value,
  label = "Saved details",
}: {
  value: unknown;
  label?: string;
}): JSX.Element {
  return (
    <details className="rf-saved-data">
      <summary>{label}</summary>
      <pre>{pretty(value)}</pre>
    </details>
  );
}
export function RecordList({ items }: { items: RecordValue[] }): JSX.Element {
  return (
    <ul className="rf-record-list">
      {items.map((item, index) => (
        <li key={text(item.id, String(index))}>
          <strong>
            {text(item.name, text(item.filename, `Version ${String(item.version ?? index + 1)}`))}
          </strong>
          {typeof item.status === "string" && <span> · {item.status}</span>}
          <SavedData value={item} />
        </li>
      ))}
    </ul>
  );
}
export function Picker({
  label,
  items,
  value,
  onChange,
  allowEmpty = true,
}: {
  label: string;
  items: RecordValue[];
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
}): JSX.Element {
  const id = useId();
  const dirty = useContext(DirtyContext);
  return (
    <SelectField
      id={id}
      label={label}
      value={value}
      onChange={(e) => {
        if (
          dirty?.current.size &&
          !window.confirm("Discard unsaved changes before changing selection?")
        )
          return;
        onChange(e.target.value);
      }}
    >
      {allowEmpty && <option value="">Choose an item</option>}
      {items.map((item) => (
        <option key={String(item.id)} value={String(item.id)}>
          {text(item.name, text(item.filename, `Version ${String(item.version)}`))}
        </option>
      ))}
    </SelectField>
  );
}
type ActionFormProps = {
  title: string;
  fields: readonly FieldSpec[];
  initial?: RecordValue;
  path: string;
  method?: string;
  fixed?: RecordValue;
  readOnly?: boolean;
  confirm?: string;
  onSaved?: () => void;
  submitLabel?: string;
};
export function ActionForm(props: ActionFormProps): JSX.Element {
  return <ActionEditor key={`${props.path}-${props.method ?? "POST"}`} {...props} />;
}
function ActionEditor({
  title,
  fields,
  initial = {},
  path,
  method = "POST",
  fixed = {},
  readOnly = false,
  confirm,
  onSaved,
  submitLabel = "Save changes",
}: ActionFormProps): JSX.Element {
  const client = useChannelsClient();
  const controller = useRef(new AbortController());
  useEffect(() => {
    if (controller.current.signal.aborted) controller.current = new AbortController();
    return (): void => controller.current.abort();
  }, []);
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        initial[f.key] === undefined || initial[f.key] === null
          ? f.kind === "object"
            ? "{}"
            : f.kind === "array"
              ? "[]"
              : ""
          : typeof initial[f.key] === "string"
            ? String(initial[f.key])
            : pretty(initial[f.key]),
      ]),
    ),
  );
  const [error, setError] = useState("");
  const [result, setResult] = useState<RecordValue | RecordValue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyForms = useContext(DirtyContext);
  useEffect(() => {
    if (dirty) dirtyForms?.current.add(base);
    else dirtyForms?.current.delete(base);
    return (): void => {
      dirtyForms?.current.delete(base);
    };
  }, [dirty, dirtyForms, base]);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || (!readOnly && !canEdit(client.role))) return;
    setError("");
    setResult(null);
    const actionClient = new ChannelsClient(
      client.workspaceId,
      AbortSignal.any([controller.current.signal, client.signal]),
      client.role,
    );
    try {
      let payload = { ...formPayload(fields, values), ...fixed };
      if (/^channels(?:\/[^/]+)?$/.test(path) && fields.some((field) => field.key === "name"))
        payload = channelPayload(payload);
      if (confirm && !window.confirm(confirm)) return;
      setBusy(true);
      const response = await actionClient.request(path, { method, body: payload, readOnly });
      if (actionClient.signal.aborted) return;
      setResult(response);
      setDirty(false);
      onSaved?.();
    } catch (e) {
      if (!actionClient.signal.aborted) setError(failure(e));
    } finally {
      if (!actionClient.signal.aborted) setBusy(false);
    }
  };
  return (
    <Panel>
      <h3>{title}</h3>
      <form className="rf-detail-form" onSubmit={(e) => void submit(e)}>
        <fieldset
          disabled={busy || (!readOnly && !canEdit(client.role))}
          className="rf-channel-fields"
        >
          <legend className="rf-sr-only">{title}</legend>
          {fields.map((field) => {
            const props = {
              id: `${base}-${field.key}`,
              label: field.label,
              value: values[field.key] ?? "",
              onChange: (e: { target: { value: string } }): void => {
                setValues((v) => ({ ...v, [field.key]: e.target.value }));
                setDirty(true);
              },
              ...(field.hint ? { hint: field.hint } : {}),
            };
            return field.kind === "object" || field.kind === "array" ? (
              <TextAreaField key={field.key} {...props} rows={4} />
            ) : (
              <Field
                key={field.key}
                {...props}
                required={!field.optional}
                type={field.kind === "number" ? "number" : "text"}
              />
            );
          })}
        </fieldset>
        {dirty && <p role="status">Unsaved changes</p>}
        {error && (
          <Alert title="Changes not saved" tone="danger">
            {error}
          </Alert>
        )}
        <Button type="submit" loading={busy} disabled={!readOnly && !canEdit(client.role)}>
          {submitLabel}
        </Button>
        {result && (
          <div role="status">
            <p>{readOnly ? "Preview ready. Nothing was saved." : "Saved by the server."}</p>
            <SavedData value={result} label="View result" />
          </div>
        )}
      </form>
    </Panel>
  );
}
export function ReadCollection({
  title,
  path,
  shape = "named",
}: {
  title: string;
  path: string;
  shape?: Shape;
}): JSX.Element {
  const [revision, setRevision] = useState(0);
  const state = useResource(path, true, shape, revision);
  return (
    <Panel>
      <div className="rf-section-header">
        <h3>{title}</h3>
        <Button tone="ghost" onClick={() => setRevision((v) => v + 1)}>
          Refresh {title.toLowerCase()}
        </Button>
      </div>
      <ResourceState {...state} empty={state.data.length === 0} />
      {!state.error && <RecordList items={state.data} />}
    </Panel>
  );
}
export function RequestFailure({ error }: { error: unknown }): JSX.Element {
  return (
    <Alert
      tone="danger"
      title={
        error instanceof ChannelApiError && error.status === 403
          ? "Permission denied"
          : "Request failed"
      }
    >
      {failure(error)}
    </Alert>
  );
}
