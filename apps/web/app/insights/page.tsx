import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { InsightsScreen } from "../../features/insights/insights-screen";

export default function InsightsPage(): JSX.Element {
  return (
    <AuthWorkspace>
      <InsightsScreen />
    </AuthWorkspace>
  );
}
