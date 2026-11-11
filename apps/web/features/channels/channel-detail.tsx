"use client";
import { StudioLink as Link } from "../../components/studio-link";
import { useState, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { Alert, Badge, Button, Panel } from "../../components/ui/primitives";
import { Tabs } from "../../components/ui/tabs";
import { segment } from "./api";
import { brandFields, preferenceFields } from "./catalog";
import { AssetPanel } from "./asset-panel";
import { CharacterPanel, GroupPanel } from "./character-panel";
import { ConfigurationPanel } from "./configuration-panel";
import { GenrePanel, SeriesPanel, SnapshotsPanel } from "./content-panels";
import { canEdit, roleNotice, type ApiObject, text } from "./model";
import { ActionForm, ChannelsScope, ResourceState, SavedData, useChannelsClient, useResource } from "./ui";
export function ChannelDetail({ channelId }: { channelId: string }): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <ChannelsScope
      key={`${workspace.id}-${workspace.role}-${channelId}`}
      workspaceId={workspace.id}
      role={workspace.role}
    >
      <Detail channelId={channelId} />
    </ChannelsScope>
  );
}
function Detail({ channelId }: { channelId: string }): JSX.Element {
  const client = useChannelsClient();
  const [revision, setRevision] = useState(0);
  const path = `channels/${segment(channelId)}`;
  const state = useResource(path, false, "channel", revision);
  const channel = state.data[0];
  return (
    <section aria-labelledby="channel-title">
      <Link href="/channels" className="rf-button rf-button--ghost">
        ← Back to channels
      </Link>
      <ResourceState {...state} empty={!channel} />
      {!state.error && channel && (
        <>
          <header className="rf-page-heading">
            <p className="rf-eyebrow">Channels / Detail</p>
            <h1 id="channel-title">{text(channel.name)}</h1>
            <Badge tone={channel.status === "ACTIVE" ? "success" : "neutral"}>
              {text(channel.status)}
            </Badge>
            <p>
              {text(
                channel.description,
                "Identity, creative policies and reusable production references.",
              )}
            </p>
            <Button tone="secondary" onClick={() => setRevision((v) => v + 1)}>
              Refresh channel
            </Button>
          </header>
          {!canEdit(client.role) && (
            <Alert tone="warning" title="Read-only channel management">
              {client.role === "VIEWER"
                ? "Your workspace role is Viewer. Channel editing requires Owner or Editor."
                : roleNotice}
            </Alert>
          )
          <Tabs
            label="Channel configuration sections"
            items={[
              {
                id: "overview",
                label: "Overview",
                content: (
                  <Overview
                    channel={channel}
                    path={path}
                    onSaved={() => setRevision((v) => v + 1)}
                  />
                ),
              },
              {
                id: "brand",
                label: "Brand & identity",
                content: (
                  <ActionForm
                    key="brand"
                    title="Brand & identity"
                    fields={brandFields}
                    initial={channel}
                    path={path}
                    method="PATCH"
                    onSaved={() => setRevision((v) => v + 1)}
                  />
                ),
              },
              {
                id: "content",
                label: "Content & genres",
                content: (
                  <>
                    <Panel>
                      <h2>Content preferences</h2>
                      <p>
                        Structured policies preserve the existing configuration format. Destination
                        intents do not establish OAuth connections; auto-publish cannot bypass
                        review or safety gates.
                      </p>
                    </Panel>
                    <ActionForm
                      key="preferences"
                      title="Channel content preferences"
                      fields={preferenceFields}
                      initial={preferences(channel)}
                      path={path}
                      method="PATCH"
                      onSaved={() => setRevision((v) => v + 1)}
                    />
                    <GenrePanel />
                  </>
                ),
              },
              { id: "series", label: "Series", content: <SeriesPanel channelId={channelId} /> },
              {
                id: "characters",
                label: "Characters & assets",
                content: (
                  <>
                    <CharacterPanel />
                    <GroupPanel channelId={channelId} />
                    <AssetPanel />
                  </>
                ),
              },
              {
                id: "config",
                label: "Configuration",
                content: (
                  <>
                    <SnapshotsPanel channelId={channelId} channel={channel} />
                    <ConfigurationPanel channelId={channelId} />
                  </>
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
function preferences(channel: ApiObject): ApiObject {
  return Object.fromEntries(
    preferenceFields
      .filter((f) => channel[f.key] !== null && channel[f.key] !== undefined)
      .map((f) => [f.key, channel[f.key]]),
  );
}
function Overview({
  channel,
  path,
  onSaved,
}: {
  channel: ApiObject;
  path: string;
  onSaved: () => void;
}): JSX.Element {
  return (
    <div className="rf-channel-stack">
      <Panel>
        <h2>Channel overview</h2>
        <dl>
          {["handle", "niche", "language", "audience", "timezone"].map((k) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{text(channel[k])}</dd>
            </div>
          ))}
        </dl>
        <SavedData value={channel} label="Preview saved channel configuration" />
      </Panel>
      <Panel>
        <h3>Channel lifecycle</h3>
        <p>
          Pausing or archiving changes production availability. Confirm the change before saving.
        </p>
        {["ACTIVE", "PAUSED", "ARCHIVED"]
          .filter((s) => s !== channel.status)
          .map((status) => (
            <ActionForm
              key={status}
              title={
                status === "ACTIVE"
                  ? "Activate channel"
                  : status === "PAUSED"
                    ? "Pause channel"
                    : "Archive channel"
              }
              fields={[]}
              path={`${path}/status`}
              fixed={{ status }}
              confirm={`Change this channel to ${status.toLowerCase()}?`}
              submitLabel={
                status === "ACTIVE"
                  ? "Activate channel"
                  : status === "PAUSED"
                    ? "Pause channel"
                    : "Archive channel"
              }
              onSaved={onSaved}
            />
          ))}
      </Panel>
    </div>
  );
}
