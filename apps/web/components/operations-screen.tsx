"use client";

import type { JSX } from "react";
import { OperationsDashboard } from "./operations-dashboard";
import { useActiveWorkspace } from "./studio-workspace-context";

export function OperationsScreen(): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <OperationsDashboard
      key={`${workspace.id}:${workspace.role}`}
      context={{ workspaceId: workspace.id, role: workspace.role }}
    />
  );
}
