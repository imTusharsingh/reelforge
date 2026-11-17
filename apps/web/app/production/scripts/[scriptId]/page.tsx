/** @deprecated V8 replaces this screen with /runs and /approvals; retained until T2. */
import { ProductionStart } from "../../../../features/production/start";

export default async function ProductionScriptPage({
  params,
}: {
  params: Promise<{ scriptId: string }>;
}): Promise<React.JSX.Element> {
  return <ProductionStart scriptId={(await params).scriptId} />;
}
