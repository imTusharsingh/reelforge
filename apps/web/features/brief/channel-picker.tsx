"use client";

import { useEffect, useState, type JSX, type ReactNode } from "react";
import { StudioLink } from "../../components/studio-link";
import { Alert, SelectField } from "../../components/ui/primitives";
import { EmptyState, Skeleton } from "../../components/ui/studio";
import type { Channel } from "../publishing/model";
import { usePublishingClient } from "../publishing/session";

export function ChannelPicker({ children, disabled = false }: { disabled?: boolean; children: (channel: Channel) => ReactNode }): JSX.Element {
  const client = usePublishingClient();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client.channels().then((data) => {
      if (active) setChannels(data.filter((channel) => channel.status !== "ARCHIVED"));
    }, () => {
      if (active) setError("Could not load your channels.");
    });
    return (): void => { active = false; };
  }, [client]);

  if (error) return <Alert title="Channels unavailable" tone="danger">{error}</Alert>;
  if (!channels) return <Skeleton label="Loading channels…" />;
  const selected = channels.find((channel) => channel.id === id) ?? channels[0];
  if (!selected) return <EmptyState title="No active channels"><StudioLink href="/onboarding">Set up a channel</StudioLink></EmptyState>;
  return (
    <div className="rf-stack">
      <SelectField id="studio-channel" label="Channel" disabled={disabled} value={selected.id} onChange={(event) => setId(event.target.value)}>
        {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
      </SelectField>
      {children(selected)}
    </div>
  );
}
