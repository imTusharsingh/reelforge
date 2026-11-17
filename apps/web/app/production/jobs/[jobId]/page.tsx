/** @deprecated V8 replaces this screen with /runs and /approvals; retained until T2. */
import { ProductionStudio } from "../../../../features/production/studio";

export default async function ProductionJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): Promise<React.JSX.Element> {
  return <ProductionStudio jobId={(await params).jobId} />;
}
