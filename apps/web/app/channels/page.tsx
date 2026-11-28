"use client";
import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { StudioLink } from "../../components/studio-link";
import { ChannelPicker } from "../../features/brief/channel-picker";
import { PublishingScope } from "../../features/publishing/session";
export default function Channels(): JSX.Element {
  return (
    <AuthWorkspace>
      <h1>Channels</h1>
      <PublishingScope>
        <ChannelPicker>
          {(channel) => (
            <StudioLink href={`/channels/${channel.id}`}>Open {channel.name}</StudioLink>
          )}
        </ChannelPicker>
      </PublishingScope>
    </AuthWorkspace>
  );
}
