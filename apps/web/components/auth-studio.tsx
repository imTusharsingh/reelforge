"use client";
import type { JSX, ReactNode } from "react";
import { AppShell } from "./app-shell";
import { Alert } from "./ui/primitives";
import { NotificationProvider } from "./ui/notifications";
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
    <NotificationProvider key={`${workspace.id}:${workspace.role}`}>
      <AppShell
        workspaceName={workspace.name}
        onWorkspaceSwitch={() => {
          if (requestNavigationIntent("workspace")) onSwitch();
        }}
        onSignOut={() => {
          if (!requestNavigationIntent("logout")) return false;
          void onLogout();
          return true;
        }}
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
    </NotificationProvider>
  );
}
