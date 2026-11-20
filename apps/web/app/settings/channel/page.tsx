"use client";

import type { JSX } from "react";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { BriefEditor } from "../../../features/brief/editor";
import { ChannelPicker } from "../../../features/brief/channel-picker";
import { StudioSettings } from "../../../features/brief/studio-settings";
import { PublishingScope } from "../../../features/publishing/session";

export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <StudioSettings current="/settings/channel">
        <PublishingScope>
          <ChannelPicker>{(channel) => <BriefEditor channelId={channel.id} />}</ChannelPicker>
        </PublishingScope>
      </StudioSettings>
    </AuthWorkspace>
  );
}
