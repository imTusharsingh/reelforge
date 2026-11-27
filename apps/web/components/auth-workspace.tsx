"use client";
import { useEffect, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { Alert, Button, StateMessage } from "./ui/primitives";
import { AuthForm } from "./auth-form";
import { Studio } from "./auth-studio";
import { AuthSession } from "./auth-session";
import { WorkspaceSetup } from "./workspace-setup";
export function AuthWorkspace({ children }: { children: ReactNode }): JSX.Element {
  const [session] = useState(() => new AuthSession());
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  useEffect(() => {
    void session.load();
  }, [session]);
  if (state.booting)
    return (
      <main className="rf-auth-page">
        <StateMessage kind="loading" description="Checking your session…" />
      </main>
    );
  if (state.view === "auth")
    return (
      <AuthForm
        onAuthenticated={session.authenticated}
        notice={
          state.sessionError && (
            <div className="rf-stack">
              <Alert tone="danger" title="Could not restore your session">
                {state.sessionError}
              </Alert>
              <Button tone="secondary" onClick={() => void session.retry()}>
                Retry workspace load
              </Button>
            </div>
          )
        }
      />
    );
  if (state.view === "onboarding" || !state.selected)
    return (
      <WorkspaceSetup
        workspaces={state.workspaces}
        onSelected={session.choose}
        onRefresh={session.refresh}
        generation={session.generation}
      />
    );
  return (
    <Studio
      workspace={state.selected}
      onSwitch={session.switchWorkspace}
      content={children}
      onLogout={session.logout}
      logoutError={state.logoutError}
    />
  );
}
