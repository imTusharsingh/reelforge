import type { JSX } from "react";
import { ChannelDetail } from "../../../features/channels/channel-detail";

export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}): Promise<JSX.Element> {
  return <ChannelDetail channelId={(await params).channelId} />;
}
