import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { UsageScreen } from "../../features/usage/usage-screen";
export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <UsageScreen />
    </AuthWorkspace>
  );
}
