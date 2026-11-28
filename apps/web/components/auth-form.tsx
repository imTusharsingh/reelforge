"use client";
import { useState, type FormEvent, type JSX, type ReactNode } from "react";
import { AccountEmailForm } from "./account-email-form";
import { BrandLogo } from "./brand-logo";
import { Icon } from "./ui/icon";
import { Alert, Button, Field } from "./ui/primitives";
import { ApiError, api } from "../lib/api";
import { validateAuth, type AuthMode } from "../lib/auth-validation";
function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Try again.";
}
export function AuthForm({
  onAuthenticated,
  notice,
}: {
  onAuthenticated: () => Promise<void>;
  notice?: ReactNode;
}): JSX.Element {
  const state = useAuthFormState({ onAuthenticated });
  return <AuthFormView {...state} notice={notice} />;
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
function AuthFormView(state: AuthFormState & { notice?: ReactNode }): JSX.Element {
  const { mode, setMode, setError, error, notice } = state;
  const [reset, setReset] = useState(false);
  return (
    <main className="rf-auth-page rf-auth-page--split">
      <AuthStage />
      <section className="rf-auth-card" aria-labelledby="auth-heading">
        {reset ? (
          <ResetPassword close={() => setReset(false)} />
        ) : (
          <>
            <p className="rf-eyebrow">ReelForge Studio</p>
            <h1 id="auth-heading">
              {mode === "signin" ? "Welcome back." : "Make space for good work."}
            </h1>
            <p className="rf-auth-intro">
              {mode === "signin"
                ? "Sign in to continue to your studio."
                : "Create an account and start with a workspace."}
            </p>
            {mode === "signin" && notice}
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
              {mode === "signin" && (
                <button type="button" className="rf-text-button" onClick={() => setReset(true)}>
                  Forgot password?
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function AuthStage(): JSX.Element {
  return (
    <div className="rf-auth-stage">
      <BrandLogo inverse />
      <div className="rf-auth-art" aria-hidden="true">
        <div className="rf-auth-art-frame">
          <Icon name="play" />
        </div>
        <span>9:16</span>
      </div>
      <div className="rf-auth-stage-copy">
        <p className="rf-eyebrow">Your short-form studio</p>
        <p className="rf-auth-statement">A shorter path to great Shorts.</p>
        <p>Develop ideas, review cuts, and plan your publishing schedule in one place.</p>
      </div>
    </div>
  );
}

function ResetPassword({ close }: { close: () => void }): JSX.Element {
  return (
    <>
      <h1 id="auth-heading">Reset password</h1>
      <AccountEmailForm mode="reset" />
      <button type="button" className="rf-text-button" onClick={close}>
        Back to sign in
      </button>
    </>
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
