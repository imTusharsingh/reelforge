import type { JSX } from "react";
import { AuthWorkspace } from "../../../../components/auth-workspace";
import { BriefEditor } from "../../../../features/brief/editor";
export default async function Page({
  params,
}: {
  params: Promise<{ channelId: string }>;
}): Promise<JSX.Element> {
  const { channelId } = await params;
  return (
    <AuthWorkspace>
      <BriefEditor channelId={channelId} />
    </AuthWorkspace>
  );
}
