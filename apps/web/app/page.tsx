import type { JSX } from "react";
import { AuthWorkspace } from "../components/auth-workspace";
import { OverviewScreen } from "../components/overview-screen";

export default function HomePage(): JSX.Element {
  return (
    <AuthWorkspace>
      <OverviewScreen />
    </AuthWorkspace>
  );
}
