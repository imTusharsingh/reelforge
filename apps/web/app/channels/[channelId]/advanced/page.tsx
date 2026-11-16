import type { JSX } from "react";
import { AuthWorkspace } from "../../../../components/auth-workspace";
import { ChannelDetail } from "../../../../features/channels/channel-detail";
/** @deprecated Legacy configuration is replaced by V7 Brief; remove in T2. */
export default async function Page({
  params,
}: {
  params: Promise<{ channelId: string }>;
}): Promise<JSX.Element> {
  const { channelId } = await params;
  return (
    <AuthWorkspace>
      <ChannelDetail channelId={channelId} />
    </AuthWorkspace>
  );
}
