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
import {
  draftEdited,
  registerDraft,
  requestNavigationIntent,
} from "../../components/studio-navigation";
import { pendingSave, clearPendingSave } from "./mutation-recovery";
import { StructuredField } from "./structured-field";
import { ChannelsClient, ChannelApiError, type Shape } from "./api";
import {
  canEdit,
  channelPayload,
  formPayload,
  initialFormValues,
  pretty,
  text,
  type FieldSpec,
  type ApiObject,
  type Role,
} from "./model";

export const ClientContext = createContext<ChannelsClient | null>(null);
const RefreshContext = createContext({ revision: 0, invalidate: (): void => {} });
export function useRefreshResources(): () => void {
  return useContext(RefreshContext).invalidate;
}
export function ChannelsScope({
  workspaceId,
  role,
  children,
}: {
  workspaceId: string;
  role: Role;
  children: ReactNode;
}): JSX.Element {
  const [client, setClient] = useState<ChannelsClient | null>(null);
  const [revision, setRevision] = useState(0);
  const invalidate = (): void => {
    setRevision((v) => v + 1);
    if (pendingSave(workspaceId)) setUncertain(true);
  };
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    const recover = (): void => {
      if (pendingSave(workspaceId)) {
        setUncertain(true);
        setRevision((v) => v + 1);
      }
    };
    recover();
    window.addEventListener("focus", recover);
    window.addEventListener("pageshow", recover);
    return (): void => {
      window.removeEventListener("focus", recover);
      window.removeEventListener("pageshow", recover);
    };
  }, [workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    const next = new ChannelsClient(workspaceId, controller.signal, role);
    setClient(next);
    return (): void => controller.abort();
  }, [workspaceId, role]);
  if (!client || client.workspaceId !== workspaceId || client.role !== role)
    return <StateMessage kind="loading" description="Loading workspace context…" />;
  return (
    <ClientContext.Provider value={client}>
      <RefreshContext.Provider value={{ revision, invalidate }}>
        {uncertain && (
          <Alert title="Check the outcome of an earlier save" tone="warning">
            A cancelled or interrupted request may already have committed. Saved data has been
            refreshed; inspect it before retrying.
            <Button
              onClick={() => {
                invalidate();
              }}
            >
              Refresh saved state
            </Button>
            <Button
              tone="secondary"
              onClick={() => {
                clearPendingSave(workspaceId);
                setUncertain(false);
              }}
            >
              I have reviewed the saved state
            </Button>
          </Alert>
        )}
        {children}
      </RefreshContext.Provider>
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
): { data: ApiObject[]; error: string; loading: boolean } {
  const client = useChannelsClient();
  const refresh = useContext(RefreshContext);
  const resourceKey = `${client.workspaceId}:${path}:${shape}:${list}`;
  const [state, setState] = useState({
    key: resourceKey,
    data: [] as ApiObject[],
    error: "",
    loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    const scoped = new ChannelsClient(
      client.workspaceId,
      AbortSignal.any([controller.signal, client.signal]),
      client.role,
    );
    setState((previous) => ({
      key: resourceKey,
      data: previous.key === resourceKey ? previous.data : [],
      error: "",
      loading: true,
    }));
    void (list ? scoped.list(path, shape) : scoped.get(path, shape).then((v) => [v]))
      .then((data) => {
        if (!scoped.signal.aborted) setState({ key: resourceKey, data, error: "", loading: false });
      })
      .catch((e: unknown) => {
        if (!scoped.signal.aborted)
          setState({ key: resourceKey, data: [], error: failure(e), loading: false });
      });
    return (): void => controller.abort();
  }, [client, path, list, shape, revision, refresh.revision, resourceKey]);
  return state.key === resourceKey ? state : { data: [], error: "", loading: true };
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
export function RecordList({ items }: { items: ApiObject[] }): JSX.Element {
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
  items: ApiObject[];
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
}): JSX.Element {
  const id = useId();
  return (
    <SelectField
      id={id}
      label={label}
      value={value}
      onChange={(e) => {
        if (!requestNavigationIntent("selection")) return;
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
  initial?: ApiObject;
  path: string;
  method?: string;
  fixed?: ApiObject;
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
  const incomingValues = initialFormValues(fields, initial);
  const incomingSignature = JSON.stringify(incomingValues);
  const [appliedSignature, setAppliedSignature] = useState(incomingSignature);
  const [values, setValues] = useState<Record<string, string>>(incomingValues);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ApiObject | ApiObject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const invalidate = useRefreshResources();
  useEffect(() => {
    if (!dirty) return;
    return registerDraft(base, () => {
      setValues(JSON.parse(appliedSignature) as Record<string, string>);
      setDirty(false);
    });
  }, [dirty, base, appliedSignature]);
  useEffect(() => {
    if (!dirty && incomingSignature !== appliedSignature) {
      setValues(JSON.parse(incomingSignature) as Record<string, string>);
      setAppliedSignature(incomingSignature);
    }
  }, [dirty, incomingSignature, appliedSignature]);
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
      invalidate();
      onSaved?.();
    } catch (e) {
      if (!actionClient.signal.aborted) {
        setError(
          !readOnly && e instanceof ChannelApiError && (e.status === 0 || e.status >= 500)
            ? `${failure(e)} The save outcome is uncertain; inspect refreshed data before retrying.`
            : failure(e),
        );
        if (!readOnly) invalidate();
      }
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
                draftEdited();
                setDirty(true);
              },
              ...(field.hint ? { hint: field.hint } : {}),
            };
            if (field.common)
              return (
                <StructuredField
                  key={field.key}
                  id={props.id}
                  field={field}
                  value={props.value}
                  onChange={(value) => props.onChange({ target: { value } })}
                />
              );
            return field.kind === "object" || field.kind === "array" || field.kind === "lines" ? (
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
        {dirty && incomingSignature !== appliedSignature && (
          <Alert title="Saved data changed" tone="warning">
            Your edits are preserved. Review the latest server values before saving.
            <Button
              tone="secondary"
              onClick={() => {
                if (requestNavigationIntent("selection")) {
                  setValues(incomingValues);
                  setAppliedSignature(incomingSignature);
                  setDirty(false);
                }
              }}
            >
              Load latest saved values
            </Button>
          </Alert>
        )}
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
