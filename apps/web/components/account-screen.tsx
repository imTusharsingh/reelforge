"use client";

import { useEffect, useState, type FormEvent, type JSX } from "react";
import { Alert, Button, Field, Panel, StateMessage } from "./ui/primitives";
import { ApiError, api, type AuthMe } from "../lib/api";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 || error.code === "TOO_MANY_ATTEMPTS") {
      return "Too many attempts. Try again later.";
    }
    if (error.status === 401 && error.code === "INVALID_CREDENTIALS") {
      return "Current password is incorrect.";
    }
    if (error.status === 401) {
      return "Your session has expired. Sign in again.";
    }
    if (error.status === 400) {
      return error.message || "Check the form and try again.";
    }
    return error.message || "The request could not be completed.";
  }
  return "Something went wrong. Try again.";
}

function ProfilePanel(): JSX.Element {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .me()
      .then((result) => {
        if (!active) return;
        setMe(result);
        setDisplayName(result.displayName ?? "");
      })
      .catch((cause) => {
        if (!active) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError("");
    setSuccess("");
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError("Display name is required.");
      return;
    }
    setSaving(true);
    try {
      const result = await api.updateMe(trimmed);
      setMe(result);
      setDisplayName(result.displayName ?? "");
      setSuccess("Profile updated.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Panel>
        <StateMessage kind="loading" description="Loading your account…" />
      </Panel>
    );
  }

  if (!me && error) {
    return (
      <Panel>
        <Alert tone="danger" title="Could not load your account">
          {error}
        </Alert>
      </Panel>
    );
  }

  return (
    <Panel>
      <p className="rf-eyebrow">Profile</p>
      <h2>Account details</h2>
      <p className="rf-muted">Your email is read-only. Email changes aren&apos;t available yet.</p>
      {error && (
        <Alert tone="danger" title="Profile not updated">
          {error}
        </Alert>
      )}
      {success && (
        <Alert tone="success" title="Saved">
          {success}
        </Alert>
      )}
      <form className="rf-form" onSubmit={save} noValidate>
        <Field id="account-email" label="Email" value={me?.email ?? ""} readOnly disabled />
        <Field
          id="account-display-name"
          label="Display name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          autoComplete="name"
        />
        <Button type="submit" loading={saving}>
          Save profile
        </Button>
      </form>
    </Panel>
  );
}

function PasswordPanel(): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation must match.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(
        `Password changed. ${result.revokedSessions} other ${
          result.revokedSessions === 1 ? "session was" : "sessions were"
        } signed out.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <p className="rf-eyebrow">Security</p>
      <h2>Change password</h2>
      <p className="rf-muted">
        Use at least 12 characters. Changing your password signs out other sessions.
      </p>
      {error && (
        <Alert tone="danger" title="Password not changed">
          {error}
        </Alert>
      )}
      {success && (
        <Alert tone="success" title="Password changed">
          {success}
        </Alert>
      )}
      <form className="rf-form" onSubmit={submit} noValidate>
        <Field
          id="current-password"
          type="password"
          label="Current password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password"
        />
        <Field
          id="new-password"
          type="password"
          label="New password"
          hint="Use at least 12 characters."
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
        />
        <Field
          id="confirm-new-password"
          type="password"
          label="Confirm new password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
        />
        <Button type="submit" loading={busy} disabled={busy}>
          Change password
        </Button>
      </form>
    </Panel>
  );
}

export function AccountScreen(): JSX.Element {
  return (
    <section className="rf-account-page" aria-labelledby="account-heading">
      <p className="rf-eyebrow">Account</p>
      <h1 id="account-heading">Profile and security</h1>
      <p className="rf-lede">Manage your profile and keep your account secure.</p>
      <div className="rf-account-grid">
        <ProfilePanel />
        <PasswordPanel />
      </div>
    </section>
  );
}
