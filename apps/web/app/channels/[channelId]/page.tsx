import type { JSX } from "react";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { ChannelOverview } from "../../../features/brief/channel-overview";
export default async function Page({
  params,
}: {
  params: Promise<{ channelId: string }>;
}): Promise<JSX.Element> {
  const { channelId } = await params;
  return (
    <AuthWorkspace>
      <ChannelOverview channelId={channelId} />
    </AuthWorkspace>
  );
}
