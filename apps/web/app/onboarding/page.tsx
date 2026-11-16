import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { Onboarding } from "../../features/brief/onboarding";
export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <Onboarding />
    </AuthWorkspace>
  );
}
