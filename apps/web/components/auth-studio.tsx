"use client";
import type { JSX, ReactNode } from "react";
import { AppShell } from "./app-shell";
import { Alert, Badge, Button } from "./ui/primitives";
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
      inspector={<StudioInspector workspace={workspace} />}
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

function StudioInspector({ workspace }: { workspace: Workspace }): JSX.Element {
  return (
    <>
      <p className="rf-eyebrow">Setup checklist</p>
      <h2>{workspace.name}</h2>
      <div className="rf-checklist">
        <Badge tone="success">Verified</Badge>
        <span>Workspace created</span>
      </div>
      <p>Set up your Channel Brief and provider keys to begin.</p>
    </>
  );
}
