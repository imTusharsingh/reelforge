"use client";
import { StudioLink as Link } from "../../components/studio-link";
import { useMemo, useState, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Alert, Badge, Button, Field, Panel, SelectField } from "../../components/ui/primitives";
import { parseChannel } from "./dto";
import { useChannelsClient } from "./ui";
import { filterChannels, roleNotice } from "./model";
import { ActionForm, ChannelsScope, ResourceState, useResource } from "./ui";
export function ChannelsWorkspace(): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <ChannelsScope key={workspace.id} workspaceId={workspace.id}>
      <ChannelList />
    </ChannelsScope>
  );
}
function ChannelList(): JSX.Element {
  const client = useChannelsClient();
  const [revision, setRevision] = useState(0);
  const state = useResource("channels", true, "channel", revision);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const filtered = useMemo(
    () =>
      filterChannels(
        state.data.map((v) => parseChannel(v, client.workspaceId)),
        query,
        status,
      ),
    [state.data, query, status, client.workspaceId],
  );
  return (
    <section aria-labelledby="channels-heading">
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Channels</p>
        <h1 id="channels-heading">Channels</h1>
        <p>Shape the identity, content and reusable creative references behind your productions.</p>
      </header>
      <Alert tone="warning" title="Read-only channel management">
        {roleNotice}
      </Alert>
      <ActionForm
        title="Create a channel"
        fields={[{ key: "name", label: "Channel name" }]}
        path="channels"
        submitLabel="Create channel"
        onSaved={() => setRevision((v) => v + 1)}
      />
      <Panel>
        <div className="rf-section-header">
          <h2>Your channels</h2>
          <Button tone="secondary" onClick={() => setRevision((v) => v + 1)}>
            Refresh channels
          </Button>
        </div>
        <div className="rf-filter-row">
          <Field
            id="channel-search"
            label="Search channels"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, handle or niche"
          />
          <SelectField
            id="channel-status"
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="ALL">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="ARCHIVED">Archived</option>
          </SelectField>
        </div>
        <ResourceState {...state} empty={!state.loading && !state.data.length} />
        {!state.loading && !state.error && (
          <>
            <p>
              {filtered.length} of {state.data.length} channels
            </p>
            {!filtered.length && state.data.length > 0 && <p>No channels match these filters.</p>}
            <div className="rf-channel-grid">
              {filtered.map((c) => (
                <Link
                  className="rf-channel-card"
                  key={c.id}
                  href={`/channels/${encodeURIComponent(c.id)}`}
                >
                  <Badge
                    tone={
                      c.status === "ACTIVE"
                        ? "success"
                        : c.status === "PAUSED"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {c.status.toLowerCase()}
                  </Badge>
                  <h3>{c.name}</h3>
                  <p>
                    {typeof c.description === "string" ? c.description : "Open channel workspace"}
                  </p>
                </Link>
              ))}
            </div>
          </>
        )}
      </Panel>
    </section>
  );
}
