"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
} from "react";
import { requestNavigationIntent } from "./studio-navigation";
import { AppShell } from "./app-shell";
import { Alert, Badge, Button, Field, Panel, StateMessage } from "./ui/primitives";
import { ApiError, api, type Workspace } from "../lib/api";
import { validateAuth, type AuthMode } from "../lib/auth-validation";
import {
  isAlreadyInvalidSession,
  isCurrentGeneration,
  resolveCurrentRequest,
  sessionFailureMessage,
} from "../lib/session-policy";
import { WorkspaceProvider } from "./studio-workspace-context";

type View = "auth" | "onboarding" | "studio";

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}

function AuthForm({ onAuthenticated }: { onAuthenticated: () => Promise<void> }): JSX.Element {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const validation = validateAuth(email, password, displayName, mode);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "signin") await api.login(email.trim(), password);
      else await api.register(email.trim(), password, displayName.trim());
      await onAuthenticated();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="rf-auth-page">
      <div className="rf-auth-brand">
        <span className="rf-auth-mark" aria-hidden="true">
          R
        </span>
        <span>
          Reel<span>Forge</span>
        </span>
      </div>
      <section className="rf-auth-card" aria-labelledby="auth-heading">
        <p className="rf-eyebrow">The creator&apos;s control room</p>
        <h1 id="auth-heading">
          {mode === "signin" ? "Welcome back." : "Make space for good work."}
        </h1>
        <p className="rf-auth-intro">
          {mode === "signin"
            ? "Sign in to continue to your studio."
            : "Create an account and start with a workspace."}
        </p>
        {error && (
          <Alert tone="danger" title="Unable to continue">
            {error}
          </Alert>
        )}
        <form className="rf-form" onSubmit={submit} noValidate>
          {mode === "register" && (
            <Field
              id="display-name"
              label="Display name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
            />
          )}
          <Field
            id="email"
            type="email"
            label="Email address"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
          <div className="rf-password-field">
            <Field
              id="password"
              type={visible ? "text" : "password"}
              label="Password"
              {...(mode === "register" ? { hint: "Use at least 12 characters." } : {})}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
            />
            <button
              className="rf-password-toggle"
              type="button"
              onClick={() => setVisible(!visible)}
              aria-pressed={visible}
            >
              {visible ? "Hide" : "Show"}
            </button>
          </div>
          <Button type="submit" loading={busy}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>
        <div className="rf-auth-links">
          <button
            type="button"
            className="rf-text-button"
            onClick={() => {
              setMode(mode === "signin" ? "register" : "signin");
              setError("");
            }}
          >
            {mode === "signin" ? "Create an account" : "I already have an account"}
          </button>
          <p className="rf-auth-unavailable" aria-disabled="true">
            Forgot password? Password reset isn&apos;t available yet. Contact your workspace owner.
          </p>
        </div>
      </section>
    </main>
  );
}

function WorkspaceSetup({
  workspaces,
  onSelected,
  onRefresh,
  generation,
}: {
  workspaces: Workspace[];
  onSelected: (workspace: Workspace) => void;
  onRefresh: (generation: number) => Promise<Workspace[] | null>;
  generation: number;
}): JSX.Element {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorTitle, setErrorTitle] = useState("Workspace not created");
  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a workspace name.");
      return;
    }
    setBusy(true);
    setError("");
    setErrorTitle("Workspace not created");
    const operationGeneration = generation;
    let created = false;
    try {
      const workspace = await api.createWorkspace(name.trim());
      created = true;
      const refreshed = await onRefresh(operationGeneration);
      if (refreshed === null) return;
      if (!refreshed.some((candidate) => candidate.id === workspace.id)) {
        setErrorTitle("Workspace needs attention");
        setError(
          "The workspace was created, but it is not in the authorized workspace list. Reload and try again.",
        );
        return;
      }
      const authorized = refreshed.find((candidate) => candidate.id === workspace.id);
      if (authorized) onSelected(authorized);
    } catch (cause) {
      if (created) setErrorTitle("Workspace created, but list refresh failed");
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rf-onboarding" aria-labelledby="setup-heading">
      <p className="rf-eyebrow">First run</p>
      <h1 id="setup-heading">Set up your studio.</h1>
      <p className="rf-lede">
        A workspace keeps your creative work together. Choose one to enter ReelForge.
      </p>
      {workspaces.length > 0 && (
        <Panel>
          <h2>Select a workspace</h2>
          <div className="rf-workspace-list">
            {workspaces.map((workspace) => (
              <button
                className="rf-workspace-option"
                key={workspace.id}
                type="button"
                onClick={() => onSelected(workspace)}
              >
                <strong>{workspace.name}</strong>
                <span>
                  Continue to studio <span aria-hidden="true">→</span>
                </span>
              </button>
            ))}
          </div>
        </Panel>
      )}
      <Panel>
        <h2>{workspaces.length ? "Or create another" : "Create your first workspace"}</h2>
        {error && (
          <Alert tone="danger" title={errorTitle}>
            {error}
          </Alert>
        )}
        <form className="rf-create-form" onSubmit={create}>
          <Field
            id="workspace-name"
            label="Workspace name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Sunday Stories"
          />
          <Button type="submit" loading={busy}>
            Create workspace
          </Button>
        </form>
      </Panel>
    </section>
  );
}

function Studio({
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
      inspector={
        <>
          <p className="rf-eyebrow">Setup checklist</p>
          <h2>{workspace.name}</h2>
          <div className="rf-checklist">
            <div>
              <Badge tone="success">Verified</Badge>
              <span>Workspace created</span>
            </div>
            <div>
              <Badge tone="warning">Next</Badge>
              <span>Choose your first production action</span>
            </div>
            <div>
              <Badge tone="neutral">Later</Badge>
              <span>External integrations are not configured</span>
            </div>
          </div>
          <p className="rf-muted">
            Channels, providers, publishing and asset storage arrive in later milestones.
          </p>
        </>
      }
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

export function AuthWorkspace({ children }: { children: ReactNode }): JSX.Element {
  const [view, setView] = useState<View>("auth");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [booting, setBooting] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [logoutError, setLogoutError] = useState("");
  const generation = useRef(0);
  const clearSession = (): void => {
    generation.current += 1;
    window.localStorage.removeItem("reelforge.activeWorkspace");
    setWorkspaces([]);
    setSelected(null);
    setView("auth");
    setBooting(false);
  };
  const refresh = async (expectedGeneration = generation.current): Promise<Workspace[] | null> => {
    const requestGeneration = expectedGeneration;
    try {
      const items = await resolveCurrentRequest(
        api.listWorkspaces(),
        () => generation.current,
        requestGeneration,
      );
      if (items === null) return null;
      setWorkspaces(items);
      return items;
    } catch (cause) {
      if (
        isCurrentGeneration(generation.current, requestGeneration) &&
        (isAlreadyInvalidSession(cause) || (cause instanceof ApiError && cause.status === 403))
      ) {
        clearSession();
        setSessionError(
          cause instanceof ApiError && cause.status === 403
            ? "Your workspace access was denied."
            : sessionFailureMessage(cause),
        );
        return null;
      }
      throw cause;
    }
  };
  const loadSession = async (): Promise<void> => {
    const operationGeneration = generation.current;
    try {
      const items = await refresh(operationGeneration);
      if (items === null) return;
      const saved = window.localStorage.getItem("reelforge.activeWorkspace");
      const item = items.find((candidate) => candidate.id === saved);
      if (item) {
        setSelected(item);
        setView("studio");
      } else setView("onboarding");
    } catch (cause) {
      if (!isCurrentGeneration(generation.current, operationGeneration)) return;
      if (cause instanceof ApiError && cause.status !== 401) setSessionError(errorText(cause));
      setView("auth");
    } finally {
      if (isCurrentGeneration(generation.current, operationGeneration)) setBooting(false);
    }
  };
  useEffect(() => {
    void loadSession();
  }, []);
  const choose = (workspace: Workspace): void => {
    generation.current += 1;
    window.localStorage.setItem("reelforge.activeWorkspace", workspace.id);
    setSelected(workspace);
    setView("studio");
  };
  const switchWorkspace = (): void => {
    generation.current += 1;
    setSelected(null);
    setView("onboarding");
  };
  const retryWorkspaceLoad = async (): Promise<void> => {
    const operationGeneration = generation.current;
    setSessionError("");
    setBooting(true);
    try {
      const items = await refresh(operationGeneration);
      if (!isCurrentGeneration(generation.current, operationGeneration)) return;
      if (items !== null) setView("onboarding");
    } catch (cause) {
      if (!isCurrentGeneration(generation.current, operationGeneration)) return;
      setSessionError(errorText(cause));
    } finally {
      if (isCurrentGeneration(generation.current, operationGeneration)) setBooting(false);
    }
  };
  const logout = async (): Promise<void> => {
    setLogoutError("");
    try {
      await api.logout();
      clearSession();
    } catch (cause) {
      if (isAlreadyInvalidSession(cause)) clearSession();
      else setLogoutError(sessionFailureMessage(cause));
    }
  };
  const message = useMemo(
    () =>
      sessionError ? (
        <Alert tone="danger" title="Could not restore your session">
          {sessionError}
          <br />
          <Button tone="secondary" onClick={() => void retryWorkspaceLoad()}>
            Retry workspace load
          </Button>
        </Alert>
      ) : null,
    [sessionError],
  );
  if (booting)
    return (
      <main className="rf-auth-page">
        <StateMessage kind="loading" description="Checking your session…" />
      </main>
    );
  if (view === "auth")
    return (
      <>
        <AuthForm
          onAuthenticated={async () => {
            setSessionError("");
            generation.current += 1;
            const operationGeneration = generation.current;
            try {
              if (
                (await refresh(operationGeneration)) !== null &&
                isCurrentGeneration(generation.current, operationGeneration)
              )
                setView("onboarding");
            } catch (cause) {
              if (!isCurrentGeneration(generation.current, operationGeneration)) return;
              setSessionError(
                `Your session is active, but workspaces could not be loaded: ${errorText(cause)}`,
              );
            }
          }}
        />
        {message}
      </>
    );
  if (view === "onboarding" || !selected)
    return (
      <WorkspaceSetup
        workspaces={workspaces}
        onSelected={choose}
        onRefresh={refresh}
        generation={generation.current}
      />
    );
  return (
    <Studio
      workspace={selected}
      onSwitch={switchWorkspace}
      content={children}
      onLogout={logout}
      logoutError={logoutError}
    />
  );
}
