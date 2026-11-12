import { RenderWorkspace } from "../../../../features/production/render";

export default async function RenderPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): Promise<React.JSX.Element> {
  return <RenderWorkspace jobId={(await params).jobId} />;
}
