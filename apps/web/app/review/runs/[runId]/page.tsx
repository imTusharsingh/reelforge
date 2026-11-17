/** @deprecated V8 replaces this screen with /runs and /approvals; retained until T2. */
import { ReviewDetail } from "../../../../features/review/workspace";
export default async function ReviewRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}): Promise<React.JSX.Element> {
  const { runId } = await params;
  return <ReviewDetail key={runId} runId={runId} />;
}
