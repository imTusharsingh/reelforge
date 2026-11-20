"use client";
import { useState, type FormEvent, type JSX } from "react";
import { Alert, Button, Field } from "./ui/primitives";
import { ApiError, api } from "../lib/api";

type AccountEmailMode = "reset" | "change";

type AccountEmailState = {
  stage: "request" | "confirm" | "done";
  email: string;
  password: string;
  code: string;
  error: string;
  busy: boolean;
  setEmail: (email: string) => void;
  setPassword: (password: string) => void;
  setCode: (code: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  restart: () => void;
};

function useAccountEmail(mode: AccountEmailMode): AccountEmailState {
  const [stage, setStage] = useState<"request" | "confirm" | "done">("request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reset = mode === "reset";
  const requesting = stage === "request";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (requesting) {
        if (reset) await api.requestReset(email);
        else await api.requestEmailChange(email, password);
        setPassword("");
        setStage("confirm");
      } else {
        if (reset) await api.confirmReset(code.trim(), password);
        else await api.confirmEmailChange(code.trim());
        setCode("");
        setPassword("");
        setStage("done");
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The request could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  const restart = (): void => {
    setCode("");
    setPassword("");
    setError("");
    setStage("request");
  };
  return {
    stage,
    email,
    password,
    code,
    error,
    busy,
    setEmail,
    setPassword,
    setCode,
    submit,
    restart,
  };
}

export function AccountEmailForm({ mode }: { mode: AccountEmailMode }): JSX.Element {
  const form = useAccountEmail(mode);
  const { stage, error, busy, submit, restart } = form;
  const reset = mode === "reset";
  const requesting = stage === "request";
  if (stage === "done")
    return (
      <Alert tone="success" title={reset ? "Password reset" : "Email address verified"}>
        {reset
          ? "You can sign in with your new password."
          : "Reload and sign in with your new email address."}
      </Alert>
    );
  return (
    <form className="rf-form" onSubmit={submit}>
      {error && (
        <Alert tone="danger" title="Unable to continue">
          {error}
        </Alert>
      )}
      <AccountEmailFields mode={mode} form={form} />
      <Button type="submit" disabled={busy} loading={busy}>
        {requesting
          ? reset
            ? "Send reset code"
            : "Send verification code"
          : reset
            ? "Reset password"
            : "Verify email address"}
      </Button>
      {!requesting && (
        <button type="button" className="rf-text-button" disabled={busy} onClick={restart}>
          Request another code
        </button>
      )}
    </form>
  );
}

function AccountEmailFields({
  mode,
  form,
}: {
  mode: AccountEmailMode;
  form: AccountEmailState;
}): JSX.Element {
  const { email, password, code, setEmail, setPassword, setCode } = form;
  const reset = mode === "reset";
  const requesting = form.stage === "request";
  return (
    <>
      {requesting ? (
        <Field
          id={`account-${mode}-email`}
          label={reset ? "Email address" : "New email address"}
          type="email"
          required
          maxLength={254}
          value={email}
          autoComplete="email"
          onChange={(event) => setEmail(event.target.value)}
        />
      ) : (
        <>
          <p role="status">
            {reset
              ? "If the account exists, check your email for a reset code."
              : "Check your new mailbox for a verification code."}
          </p>
          <Field
            id={`account-${mode}-code`}
            label={reset ? "Reset code" : "Verification code"}
            required
            maxLength={43}
            value={code}
            autoComplete="one-time-code"
            onChange={(event) => setCode(event.target.value)}
          />
        </>
      )}
      {requesting !== reset && (
        <Field
          id={`account-${mode}-password`}
          label={reset ? "New password" : "Password for this account"}
          type="password"
          required
          minLength={reset ? 12 : 1}
          maxLength={1024}
          value={password}
          autoComplete={reset ? "new-password" : "current-password"}
          onChange={(event) => setPassword(event.target.value)}
        />
      )}
    </>
  );
}
