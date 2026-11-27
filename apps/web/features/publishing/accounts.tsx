"use client";

import { useEffect, useState, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { useNotify } from "../../components/ui/notifications";
import { Alert, Badge, Button, Field, Panel, SelectField } from "../../components/ui/primitives";
import { isEditableRole } from "./model";
import { usePublishingClient } from "./session";
import { useAccountLists } from "./use-account-lists";

export function Accounts(): JSX.Element {
  const workspace = useActiveWorkspace();
  const editable = isEditableRole(workspace.role);
  const api = usePublishingClient();
  const notify = useNotify();
  const { items, available, channels, replaceAccounts, hideRevoked, load } = useAccountLists(api);
  const [channel, setChannel] = useState("");
  const platform = "YOUTUBE";
  const [remoteAccountId, setRemoteAccountId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loading = useInitialAccountLoad(load, setError);
  const [notice, setNotice] = useState("");
  const [refreshNotice, setRefreshNotice] = useState("");
  const [pending, setPending] = useState(() => api.pendingAccountScopes());
  const [inspected, setInspected] = useState(false);
  const locked = busy || pending.length > 0;
  const reconcile = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      replaceAccounts(await api.reconcileAccounts());
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

  useConnectFeedback(notify, setNotice);

  const act = async <T,>(
    operation: () => Promise<T>,
    success: string,
    onCompleted?: (result: T) => void,
  ): Promise<void> => {
    if (!editable || locked) return;
    setBusy(true);
    setError("");
    setNotice("");
    setRefreshNotice("");
    notify(null);
    try {
      let result: T;
      try {
        result = await operation();
      } catch (cause) {
        notify({
          tone: "danger",
          title: "Account action failed",
          detail:
            cause instanceof Error ? cause.message : "Check the account status and try again.",
        });
        setPending(api.pendingAccountScopes());
        setInspected(false);
        return;
      }
      onCompleted?.(result);
      await refreshLists(success);
    } finally {
      setBusy(false);
    }
  };

  const refreshLists = async (completed: string, retry = false): Promise<void> => {
    if (retry) {
      if (busy) return;
      setBusy(true);
    }
    try {
      await load();
      setRefreshNotice("");
      notify({ tone: "success", title: retry ? "Account lists refreshed." : completed });
    } catch {
      setRefreshNotice(completed);
    } finally {
      if (retry) setBusy(false);
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
    <section className="rf-stack">
      <header className="rf-page-heading">
        <h2>YouTube connection</h2>
        <p>Connect a YouTube account to publish approved Shorts.</p>
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
      {refreshNotice && (
        <AccountRefreshNotice
          completed={refreshNotice}
          busy={busy}
          retry={() => void refreshLists(refreshNotice, true)}
        />
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
        <h3>Publishing availability</h3>
        {loading ? (
          <p role="status">Checking YouTube availability…</p>
        ) : available.length === 0 ? (
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
          <h3>Connect YouTube</h3>
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
        <h3>Connected accounts</h3>
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
                      onClick={() =>
                        void act(() => api.refreshAccount(account.id), "Account refreshed.")
                      }
                    >
                      Refresh
                    </Button>
                    <Button
                      tone="secondary"
                      disabled={locked}
                      onClick={() =>
                        void act(
                          () => api.checkAccountHealth(account.id),
                          "Account health checked.",
                        )
                      }
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
                          void act(
                            () => api.revokeAccount(account.id),
                            "Account disconnected.",
                            hideRevoked,
                          );
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

function useInitialAccountLoad(
  load: () => Promise<void>,
  setError: (value: string) => void,
): boolean {
  const [loading, setLoading] = useState(true);
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
  }, [load, setError]);
  return loading;
}

function useConnectFeedback(
  notify: ReturnType<typeof useNotify>,
  setNotice: (value: string) => void,
): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("oauthError");
    if (code) setNotice(`Connection failed: ${code}. Try connecting again.`);
    else if (params.has("connected"))
      notify({ tone: "success", title: "YouTube account connected." });
  }, [notify, setNotice]);
}

function AccountRefreshNotice({
  completed,
  busy,
  retry,
}: {
  completed: string;
  busy: boolean;
  retry: () => void;
}): JSX.Element {
  return (
    <Alert tone="warning" title={completed}>
      Account lists could not be refreshed. Retry the refresh without repeating the action.
      <div className="rf-action-row">
        <Button tone="secondary" disabled={busy} onClick={retry}>
          Retry list refresh
        </Button>
      </div>
    </Alert>
  );
}
