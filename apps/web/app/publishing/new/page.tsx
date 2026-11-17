import { PublishingComposer } from "../../../features/publishing/automation-composer";
import { Suspense } from "react";
export default function NewPublishingPostPage(): React.JSX.Element {
  return (
    <Suspense fallback={<p>Loading composer…</p>}>
      <PublishingComposer />
    </Suspense>
  );
}
