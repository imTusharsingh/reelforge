import type { ReactNode } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { ProductionScope } from "../../features/production/session";

export default function ProductionLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <AuthWorkspace>
      <ProductionScope>{children}</ProductionScope>
    </AuthWorkspace>
  );
}
