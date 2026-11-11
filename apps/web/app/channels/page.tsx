import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { ChannelsWorkspace } from "../../features/channels/channels-workspace";

export default function ChannelsPage(): JSX.Element {
  return (
    <AuthWorkspace>
      <ChannelsWorkspace />
    </AuthWorkspace>
  );
}
