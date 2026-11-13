"use client";

import { useCallback, useEffect, useState, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Alert, Badge, Button, Field, Panel, SelectField } from "../../components/ui/primitives";
import {
  isEditableRole,
  type Channel,
  type PlatformAvailability,
  type SocialAccount,
} from "./model";
import { usePublishingClient } from "./session";

export function Accounts(): JSX.Element {
  const workspace = useActiveWorkspace();
  const editable = isEditableRole(workspace.role);
  const api = usePublishingClient();
  const [items, setItems] = useState<SocialAccount[]>([]);
  const [available, setAvailable] = useState<PlatformAvailability[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channel, setChannel] = useState("");
  const [platform, setPlatform] = useState("");
  const [remoteAccountId, setRemoteAccountId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(() => api.pendingAccountScopes());
  const [inspected, setInspected] = useState(false);
  const locked = busy || pending.length > 0;
  const reconcile = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setItems(await api.reconcileAccounts());
      setInspected(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh accounts.");
    } finally {
      setBusy(false);
    }
  };
  const acknowledge = (): void => {
    try {
      for (const scope of pending) api.acknowledge(scope);
      setPending(api.pendingAccountScopes());
      setInspected(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to clear recovery state.");
    }
  };

  const load = useCallback(async (): Promise<void> => {
    const [nextAccounts, nextPlatforms, nextChannels] = await Promise.all([
      api.accounts(),
      api.platforms(),
      api.channels(),
    ]);
    setItems(nextAccounts);
    setAvailable(nextPlatforms);
    setChannels(nextChannels.filter((item) => item.status !== "ARCHIVED"));
  }, [api]);

  useEffect(() => {
    let active = true;
    void load()
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load accounts.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("oauthError");
    if (code) setNotice(`Connection failed: ${code}. Try connecting again.`);
    else if (params.has("connected"))
      setNotice("Account connected. Check its health and capabilities below.");
  }, []);

  const act = async (operation: () => Promise<void>): Promise<void> => {
    if (!editable || locked) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
      setPending(api.pendingAccountScopes());
      setInspected(false);
    } finally {
      setBusy(false);
    }
  };

  const connect = async (
    targetChannel: string,
    targetPlatform: string,
    accountId: string,
  ): Promise<void> => {
    if (!editable || locked || !targetChannel || !accountId) return;
    if (!available.some((item) => item.platform === targetPlatform && item.connectable)) {
      setError("Connection is unavailable for this platform.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const authorizationUrl = await api.connect(targetChannel, targetPlatform, accountId);
      window.location.assign(authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection failed.");
      setPending(api.pendingAccountScopes());
      setInspected(false);
      setBusy(false);
    }
  };

  return (
    <section>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Publishing</p>
        <h1>Social accounts</h1>
        <p>
          Connect accounts and check publishing availability. Unverified platforms remain
          unavailable.
        </p>
      </header>
      {!editable && (
        <Alert tone="warning" title="Read-only">
          An owner or editor can connect, refresh, and disconnect accounts.
        </Alert>
      )}
      {error && (
        <Alert tone="danger" title="Request failed">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="warning" title="Connection status">
          {notice}
        </Alert>
      )}
      {pending.length > 0 && (
        <Alert tone="warning" title="Previous account action may still be pending">
          Refresh and inspect the saved account status before another action.
          <div className="rf-action-row">
            <Button disabled={busy} onClick={() => void reconcile()}>
              Refresh accounts
            </Button>
            <Button disabled={busy || !inspected} onClick={acknowledge}>
              I inspected the accounts
            </Button>
          </div>
        </Alert>
      )}
      <Panel>
        <h2>Platform availability</h2>
        {available.length === 0 ? (
          <p>No platform capabilities are configured.</p>
        ) : (
          <ul>
            {available.map((item) => (
              <li key={item.platform}>
                <strong>{item.platform}</strong>{" "}
                <Badge tone={item.connectable ? "success" : "neutral"}>
                  {item.connectable ? "connectable" : "connection unavailable"}
                </Badge>{" "}
                <Badge tone={item.publishable ? "success" : "warning"}>
                  {item.publishable ? "publishable" : "publishing unavailable"}
                </Badge>
                {item.reasonCode ? <span> · {item.reasonCode}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editable && (
        <Panel>
          <h2>Connect account</h2>
          <SelectField
            id="publish-channel"
            label="Channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
          >
            <option value="">Choose a channel</option>
            {channels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            id="publish-platform"
            label="Platform"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            <option value="">Choose a platform</option>
            {available.map((item) => (
              <option key={item.platform} value={item.platform} disabled={!item.connectable}>
                {item.platform}
                {item.connectable ? "" : " — unavailable"}
              </option>
            ))}
          </SelectField>
          <Field
            id="remote-account"
            label="Platform account ID"
            value={remoteAccountId}
            onChange={(event) => setRemoteAccountId(event.target.value)}
            hint="The account is authorized by the platform; no password or token is entered here."
          />
          <Button
            disabled={
              locked ||
              !channel ||
              !platform ||
              !remoteAccountId.trim() ||
              !available.some((item) => item.platform === platform && item.connectable)
            }
            loading={busy}
            onClick={() => void connect(channel, platform, remoteAccountId.trim())}
          >
            Connect
          </Button>
        </Panel>
      )}
      <Panel>
        <h2>Connected accounts</h2>
        {loading ? (
          <p role="status">Loading accounts…</p>
        ) : items.length === 0 ? (
          <p>No accounts connected.</p>
        ) : (
          <ul className="rf-account-list">
            {items.map((account) => (
              <li key={account.id} className="rf-account-card">
                <h3>{account.displayName}</h3>
                <p>
                  {account.platform} ·{" "}
                  <Badge tone={account.health === "HEALTHY" ? "success" : "warning"}>
                    {account.health}
                  </Badge>{" "}
                  · {account.status}
                  {account.username ? ` · ${account.username}` : ""}
                </p>
                <p className="rf-account-id">Account ID: {account.remoteAccountId}</p>
                {editable && (
                  <div className="rf-action-row">
                    <Button
                      tone="secondary"
                      disabled={locked}
                      onClick={() => void act(() => api.refreshAccount(account.id))}
                    >
                      Refresh
                    </Button>
                    <Button
                      tone="secondary"
                      disabled={locked}
                      onClick={() => void act(() => api.checkAccountHealth(account.id))}
                    >
                      Check health
                    </Button>
                    <Button
                      tone="secondary"
                      disabled={
                        locked ||
                        !available.some(
                          (item) => item.platform === account.platform && item.connectable,
                        )
                      }
                      onClick={() =>
                        void connect(account.channelId, account.platform, account.remoteAccountId)
                      }
                    >
                      Reconnect
                    </Button>
                    <Button
                      tone="danger"
                      disabled={locked}
                      onClick={() => {
                        if (window.confirm(`Disconnect ${account.displayName}?`))
                          void act(() => api.revokeAccount(account.id));
                      }}
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}
