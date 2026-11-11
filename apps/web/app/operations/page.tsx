import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { OperationsScreen } from "../../components/operations-screen";

export default function OperationsPage(): JSX.Element {
  return (
    <AuthWorkspace>
      <OperationsScreen />
    </AuthWorkspace>
  );
}
