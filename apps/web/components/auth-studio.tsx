"use client";
import type { JSX, ReactNode } from "react";
import { AppShell } from "./app-shell";
import { Alert, Button } from "./ui/primitives";
import { requestNavigationIntent } from "./studio-navigation";
import type { Workspace } from "../lib/api";
import { WorkspaceProvider } from "./studio-workspace-context";
export function Studio({
  workspace,
  content,
  onSwitch,
  onLogout,
  logoutError,
}: {
  workspace: Workspace;
  content: ReactNode;
  onSwitch: () => void;
  onLogout: () => Promise<void>;
  logoutError: string;
}): JSX.Element {
  return (
    <AppShell
      workspaceName={workspace.name}
      shellActions={
        <div className="rf-actions">
          <Button
            onClick={() => {
              if (requestNavigationIntent("workspace")) onSwitch();
            }}
            tone="secondary"
          >
            Switch workspace
          </Button>
          <Button
            onClick={() => {
              if (requestNavigationIntent("logout")) void onLogout();
            }}
            tone="ghost"
          >
            Sign out
          </Button>
        </div>
      }
    >
      <WorkspaceProvider workspace={workspace}>
        {logoutError && (
          <Alert tone="danger" title="Sign out did not complete">
            {logoutError}
          </Alert>
        )}
        {content}
      </WorkspaceProvider>
    </AppShell>
  );
}
