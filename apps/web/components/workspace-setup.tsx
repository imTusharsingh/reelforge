"use client";
import { useState, type JSX } from "react";
import { Button, Panel } from "./ui/primitives";
import type { Workspace } from "../lib/api";
import { Onboarding } from "../features/brief/onboarding";
export function WorkspaceSetup({
  workspaces,
  onSelected,
}: {
  workspaces: Workspace[];
  onSelected: (workspace: Workspace) => void;
  onRefresh: (generation: number) => Promise<Workspace[] | null>;
  generation: number;
}): JSX.Element {
  const [creating, setCreating] = useState(false);
  if (!workspaces.length || creating)
    return (
      <main className="rf-onboarding">
        <Onboarding onComplete={onSelected} />
      </main>
    );
  return (
    <main className="rf-onboarding">
      <Panel>
        <h1>Choose your workspace</h1>
        {workspaces.map((workspace) => (
          <Button key={workspace.id} onClick={() => onSelected(workspace)}>
            {workspace.name}
          </Button>
        ))}
        <Button tone="secondary" onClick={() => setCreating(true)}>
          Set up a new channel
        </Button>
      </Panel>
    </main>
  );
}
