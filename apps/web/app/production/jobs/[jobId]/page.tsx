import { ProductionStudio } from "../../../../features/production/studio";

export default async function ProductionJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}): Promise<React.JSX.Element> {
  return <ProductionStudio jobId={(await params).jobId} />;
}
