/** @deprecated V8 replaces this screen with /runs and /approvals; retained until T2. */
import type { ReactNode } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { ReviewScope } from "../../features/review/session";
export default function ReviewLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <AuthWorkspace>
      <ReviewScope>{children}</ReviewScope>
    </AuthWorkspace>
  );
}
