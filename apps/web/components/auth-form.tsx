"use client";
import { useState, type FormEvent, type JSX } from "react";
import { Alert, Button, Field } from "./ui/primitives";
import { ApiError, api } from "../lib/api";
import { validateAuth, type AuthMode } from "../lib/auth-validation";
function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}
export function AuthForm({
  onAuthenticated,
}: {
  onAuthenticated: () => Promise<void>;
}): JSX.Element {
  const state = useAuthFormState({ onAuthenticated });
  return <AuthFormView {...state} />;
}
type AuthFormState = {
  mode: AuthMode;
  setMode: (v: AuthMode) => void;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  visible: boolean;
  setVisible: (v: boolean) => void;
  busy: boolean;
  error: string;
  setError: (v: string) => void;
  submit: (e: FormEvent<HTMLFormElement>) => Promise<void>;
};
function useAuthFormState({
  onAuthenticated,
}: {
  onAuthenticated: () => Promise<void>;
}): AuthFormState {
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

  return {
    mode,
    setMode,
    email,
    setEmail,
    password,
    setPassword,
    displayName,
    setDisplayName,
    visible,
    setVisible,
    busy,
    error,
    setError,
    submit,
  };
}
function AuthFormView(state: AuthFormState): JSX.Element {
  const { mode, setMode, setError, error } = state;
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
        <AuthFields {...state} />
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

function AuthFields({
  mode,
  email,
  setEmail,
  password,
  setPassword,
  displayName,
  setDisplayName,
  visible,
  setVisible,
  busy,
  submit,
}: AuthFormState): JSX.Element {
  return (
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
  );
}
