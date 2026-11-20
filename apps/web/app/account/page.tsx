import { StudioSettings } from "../../features/brief/studio-settings";
import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { AccountScreen } from "../../components/account-screen";

export default function AccountPage(): JSX.Element {
  return (
    <AuthWorkspace>
      <StudioSettings current="/account">
        <AccountScreen />
      </StudioSettings>
    </AuthWorkspace>
  );
}
