import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { ProviderSettings } from "../../features/brief/settings";
export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <ProviderSettings />
    </AuthWorkspace>
  );
}
