import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { Ideas } from "../../features/discovery/ideas";
import { PublishingScope } from "../../features/publishing/session";

export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <PublishingScope>
        <Ideas />
      </PublishingScope>
    </AuthWorkspace>
  );
}
