"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent, type JSX } from "react";
import { AppShell } from "../../components/app-shell";
import {
  Alert,
  Badge,
  Button,
  Field,
  Panel,
  SelectField,
  StateMessage,
} from "../../components/ui/primitives";
import { api, ApiError, type Channel, type Workspace } from "../../lib/api";

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : "The channel service could not be reached.";
}

function tone(status: Channel["status"]): "success" | "warning" | "danger" {
  return status === "ACTIVE" ? "success" : status === "PAUSED" ? "warning" : "danger";
}

export function ChannelsWorkspace(): JSX.Element {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState("");

  const load = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const workspaces = await api.listWorkspaces();
      const selected = workspaces.find((item) => !item.archivedAt) ?? null;
      setWorkspace(selected);
      if (!selected) return;
      setChannels(await api.listChannels(selected.id));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(
    () =>
      channels.filter((channel) => {
        const matchesText = `${channel.name} ${channel.handle ?? ""} ${channel.niche ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase());
        return matchesText && (status === "ALL" || channel.status === status);
      }),
    [channels, query, status],
  );

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!workspace || !name.trim()) {
      setCreateError("Enter a channel name.");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      const created = await api.createChannel(workspace.id, { name: name.trim() });
      setChannels((current) => [created, ...current]);
      setName("");
    } catch (cause) {
      setCreateError(message(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <AppShell>
      <div className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Channels</p>
        <h1>Channels</h1>
        <p>
          Define the identity, editorial rules, and reusable assets that guide each production
          channel.
        </p>
      </div>
      {error && (
        <Alert tone="danger" title="Channels unavailable">
          {error}
        </Alert>
      )}
      {!loading && !workspace && !error && (
        <StateMessage
          kind="forbidden"
          description="Choose or create a workspace before managing channels."
        />
      )}
      {loading && <StateMessage kind="loading" description="Loading your authorized channels…" />}
      {workspace && !loading && (
        <>
          <Panel className="rf-channel-create">
            <div className="rf-section-header">
              <div>
                <h2>Create a channel</h2>
                <p>Start with a name; the rest can be refined in the detail workspace.</p>
              </div>
            </div>
            <form className="rf-channel-form" onSubmit={create}>
              <Field
                id="new-channel-name"
                label="Channel name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Curious Minutes"
                error={createError}
              />
              <Button type="submit" loading={creating}>
                Create channel
              </Button>
            </form>
          </Panel>
          <div className="rf-section-header rf-channel-toolbar">
            <div>
              <h2>Your channels</h2>
              <p>
                {filtered.length} of {channels.length} channels
              </p>
            </div>
            <div className="rf-filter-row">
              <Field
                id="channel-search"
                label="Search channels"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, handle, niche"
              />
              <SelectField
                id="channel-status"
                label="Status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="ALL">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="PAUSED">Paused</option>
                <option value="ARCHIVED">Archived</option>
              </SelectField>
            </div>
          </div>
          {channels.length === 0 ? (
            <StateMessage
              kind="empty"
              description="No channels exist in this workspace yet. Create one to begin configuring your brand."
            />
          ) : filtered.length === 0 ? (
            <StateMessage kind="empty" description="No channels match these filters." />
          ) : (
            <div className="rf-channel-grid">
              {filtered.map((channel) => (
                <Link className="rf-channel-card" href={`/channels/${channel.id}`} key={channel.id}>
                  <div className="rf-channel-card__top">
                    <Badge tone={tone(channel.status)}>{channel.status.toLowerCase()}</Badge>
                    <span aria-hidden="true">→</span>
                  </div>
                  <h3>{channel.name}</h3>
                  <p>
                    {channel.description ||
                      "Brand identity and content preferences are ready to configure."}
                  </p>
                  <dl>
                    <div>
                      <dt>Handle</dt>
                      <dd>{channel.handle || "Not set"}</dd>
                    </div>
                    <div>
                      <dt>Audience</dt>
                      <dd>{channel.audience || "Not set"}</dd>
                    </div>
                  </dl>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
