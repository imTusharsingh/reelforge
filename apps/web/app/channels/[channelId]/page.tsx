import type { JSX } from "react";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { ChannelDetail } from "../../../features/channels/channel-detail";

export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}): Promise<JSX.Element> {
  return (
    <AuthWorkspace>
      <ChannelDetail channelId={(await params).channelId} />
    </AuthWorkspace>
  );
}
