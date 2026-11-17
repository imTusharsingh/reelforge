/** @deprecated V8 read-only run storyboard replaces planning edits; retained until T2. */
import { ScriptWorkspace } from "../../../../features/planning/script-workspace";
export default async function ScriptPage({
  params,
}: {
  params: Promise<{ scriptId: string }>;
}): Promise<React.JSX.Element> {
  return <ScriptWorkspace scriptId={(await params).scriptId} />;
}
