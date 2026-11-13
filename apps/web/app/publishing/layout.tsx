import type { ReactNode } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { PublishingScope } from "../../features/publishing/session";
export default function PublishingLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <AuthWorkspace>
      <PublishingScope>{children}</PublishingScope>
    </AuthWorkspace>
  );
}
