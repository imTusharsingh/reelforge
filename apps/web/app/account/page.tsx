import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { AccountScreen } from "../../components/account-screen";

export default function AccountPage(): JSX.Element {
  return (
    <AuthWorkspace>
      <section>
        <h1>Account</h1>
        <AccountScreen />
      </section>
    </AuthWorkspace>
  );
}
