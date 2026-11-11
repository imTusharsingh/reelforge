import type { ReactNode } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { PlanningScope } from "../../features/planning/session";
export default function PlanningLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <AuthWorkspace>
      <PlanningScope>{children}</PlanningScope>
    </AuthWorkspace>
  );
}
