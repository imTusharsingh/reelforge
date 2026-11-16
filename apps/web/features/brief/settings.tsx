"use client";
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { Alert, Button, Panel, StateMessage } from "../../components/ui/primitives";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { BriefClient, type KeyStatus, type SetupPorts } from "./client";
import type { ProviderCapability } from "../../../../packages/contracts/src/foundations";

export function ProviderSettings(): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <Settings
      key={`${workspace.id}:${workspace.role}`}
      workspaceId={workspace.id}
      editable={workspace.role !== "VIEWER"}
    />
  );
}
function Settings({
  workspaceId,
  editable,
}: {
  workspaceId: string;
  editable: boolean;
}): JSX.Element {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [error, setError] = useState("");
  const load = (): void => {
    void new BriefClient(workspaceId)
      .keys()
      .then(setStatus)
      .catch(() =>
        setError("Provider key settings are unavailable until the provider service is ready."),
      );
  };
  useEffect(load, [workspaceId]);
  return (
    <Panel>
      <h1>Provider keys</h1>
      <p>
        Paste each key once. The provider service stores it encrypted. Only configuration status is
        shown.
      </p>
      {error && (
        <Alert tone="danger" title="Settings unavailable">
          {error}
        </Alert>
      )}
      {(["gemini", "xai"] as const).map((provider) => (
        <KeyForm
          key={provider}
          provider={provider}
          configured={status?.[provider] ?? null}
          client={new BriefClient(workspaceId)}
          editable={editable}
          onSaved={load}
        />
      ))}
      <a href="/settings/providers">Provider health and capabilities</a>
    </Panel>
  );
}
function KeyForm({
  provider,
  configured,
  client,
  editable,
  onSaved,
}: {
  provider: "gemini" | "xai";
  configured: boolean | null;
  client: SetupPorts;
  editable: boolean;
  onSaved: () => void;
}): JSX.Element {
  const state = useKeyFormState({ provider, configured, client, editable, onSaved });
  return <KeyFormView {...state} />;
}
type KeyFormState = {
  provider: "gemini" | "xai";
  configured: boolean | null;
  editable: boolean;
  input: import("react").RefObject<HTMLInputElement | null>;
  busy: boolean;
  error: string;
  submit: (event: FormEvent) => Promise<void>;
};
function useKeyFormState({
  provider,
  configured,
  client,
  editable,
  onSaved,
}: {
  provider: "gemini" | "xai";
  configured: boolean | null;
  client: SetupPorts;
  editable: boolean;
  onSaved: () => void;
}): KeyFormState {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    let secret = input.current?.value ?? "";
    if (input.current) input.current.value = "";
    setBusy(true);
    setError("");
    try {
      await client.saveKey(provider, secret);
      onSaved();
    } catch {
      setError("Key was not saved. Paste it again to retry.");
    } finally {
      secret = "";
      setBusy(false);
    }
  };
  return { provider, configured, editable, input, busy, error, submit };
}
function KeyFormView({
  provider,
  configured,
  editable,
  input,
  busy,
  error,
  submit,
}: ReturnType<typeof useKeyFormState>): JSX.Element {
  return (
    <form onSubmit={submit} className="rf-form">
      <h2>{provider === "gemini" ? "Google (Gemini)" : "xAI fallback"}</h2>
      <p role="status">
        {configured === null
          ? "Checking configuration…"
          : configured
            ? "Configured"
            : "Not configured"}
      </p>
      {error && (
        <Alert tone="danger" title="Unable to save key">
          {error}
        </Alert>
      )}
      <label htmlFor={`key-${provider}`}>New {provider} API key</label>
      <input
        ref={input}
        id={`key-${provider}`}
        className="rf-input"
        type="password"
        autoComplete="off"
        required
        disabled={!editable || busy}
      />
      <Button type="submit" disabled={!editable} loading={busy}>
        Save {provider} key
      </Button>
    </form>
  );
}
export function ProviderHealth(): JSX.Element {
  const workspace = useActiveWorkspace();
  return <Health key={workspace.id} workspaceId={workspace.id} />;
}
function Health({ workspaceId }: { workspaceId: string }): JSX.Element {
  const state = useHealthState({ workspaceId });
  return <HealthView {...state} />;
}
function useHealthState({ workspaceId }: { workspaceId: string }): {
  capabilities: ProviderCapability[] | null;
  error: string;
} {
  const [capabilities, setCapabilities] = useState<ProviderCapability[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void new BriefClient(workspaceId)
      .capabilities()
      .then((data) => {
        if (active) setCapabilities(data);
      })
      .catch(() => {
        if (active) setError("Provider health is unavailable until the provider service is ready.");
      });
    return (): void => {
      active = false;
    };
  }, [workspaceId]);
  return { capabilities, error };
}
function HealthView({ capabilities, error }: ReturnType<typeof useHealthState>): JSX.Element {
  return (
    <Panel>
      <h1>Provider health and capabilities</h1>
      <p>Registry data only. Opening this page never probes a live provider.</p>
      {error && (
        <Alert tone="danger" title="Health unavailable">
          {error}
        </Alert>
      )}
      {!capabilities && !error && (
        <StateMessage kind="loading" description="Loading capabilities…" />
      )}
      {capabilities?.length === 0 && <p>No capabilities configured.</p>}
      {capabilities && capabilities.length > 0 && <CapabilityMatrix capabilities={capabilities} />}
    </Panel>
  );
}

function CapabilityMatrix({ capabilities }: { capabilities: ProviderCapability[] }): JSX.Element {
  return (
    <table>
      <caption>Provider capability matrix</caption>
      <thead>
        <tr>
          {[
            "Provider / model",
            "Health",
            "Kind",
            "Duration",
            "Aspects / fps",
            "References",
            "Features",
            "USD per second",
          ].map((title) => (
            <th scope="col" key={title}>
              {title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {capabilities.map((item) => (
          <tr key={item.id}>
            <th scope="row">
              {item.providerId} / {item.modelId}
            </th>
            <td>{item.health}</td>
            <td>{item.kind}</td>
            <td>
              {item.minDurationSeconds}–{item.maxDurationSeconds}s
            </td>
            <td>
              {item.aspects.join(", ")} / {item.frameRates.join(", ")}
            </td>
            <td>{item.maxReferenceImages}</td>
            <td>
              {item.firstLastFrame ? "Pinned frames. " : ""}
              {item.nativeAudio ? "Native audio. " : ""}Extension {item.maxExtensionSeconds}s.{" "}
              {item.asynchronous ? "Async. " : ""}
              {item.polling ? "Polling." : ""}
            </td>
            <td>
              {Object.entries(item.pricePerSecond)
                .map(
                  ([resolution, price]) =>
                    `${resolution}: ${price === null ? "unavailable" : `$${price / 1_000_000}`}`,
                )
                .join("; ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
