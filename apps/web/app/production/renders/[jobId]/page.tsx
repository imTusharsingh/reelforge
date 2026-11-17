/** @deprecated V8 replaces this screen with /runs and /approvals; retained until T2. */
import { RenderWorkspace } from "../../../../features/production/render";

export default async function RenderPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): Promise<React.JSX.Element> {
  return <RenderWorkspace jobId={(await params).jobId} />;
}
