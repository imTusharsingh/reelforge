/** @deprecated V8 replaces this screen with /runs and /approvals; retained until T2. */
import { ReviewQueue } from "../../features/review/workspace";
/** @deprecated V8 replaces this legacy screen; T2 removes unused code. See DEPRECATIONS.md. */
export default function ReviewPage(): React.JSX.Element {
  return <ReviewQueue />;
}
