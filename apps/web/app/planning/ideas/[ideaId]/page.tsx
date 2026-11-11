import { IdeaWorkspace } from "../../../../features/planning/idea-workspace";
export default async function IdeaPage({
  params,
}: {
  params: Promise<{ ideaId: string }>;
}): Promise<React.JSX.Element> {
  return <IdeaWorkspace ideaId={(await params).ideaId} />;
}
