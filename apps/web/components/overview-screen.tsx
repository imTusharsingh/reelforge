"use client";

import type { JSX } from "react";
import { Panel } from "./ui/primitives";
import { useActiveWorkspace } from "./studio-workspace-context";

export function OverviewScreen(): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <>
      <header className="rf-page-heading">
        <p className="rf-eyebrow">Studio / Overview</p>
        <h1>{workspace.name}</h1>
        <p>Your production space is ready for its next deliberate step.</p>
      </header>
      <div className="rf-studio-grid">
        <Panel>
          <p className="rf-eyebrow">Workspace</p>
          <h2>Keep the room focused.</h2>
          <p className="rf-muted">
            You are working in <strong>{workspace.name}</strong>. Workspace access is enforced by
            the API for every request.
          </p>
        </Panel>
        <Panel>
          <p className="rf-eyebrow">Account settings</p>
          <h2>Profile settings unavailable</h2>
          <p className="rf-muted">
            The current API does not expose an authenticated-user profile endpoint, so account edits
            are intentionally unavailable.
          </p>
        </Panel>
      </div>
    </>
  );
}
