import { StudioSettings } from "../../../features/brief/studio-settings";
import type { JSX } from "react";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { ProviderHealth } from "../../../features/brief/settings";
export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <StudioSettings current="/settings"><ProviderHealth /></StudioSettings>
    </AuthWorkspace>
  );
}
