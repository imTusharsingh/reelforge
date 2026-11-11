"use client";

import { createContext, useContext, type JSX, type ReactNode } from "react";
import type { Workspace } from "../lib/api";

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: Workspace;
  children: ReactNode;
}): JSX.Element {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

export function useActiveWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useActiveWorkspace must be used inside WorkspaceProvider");
  return workspace;
}
