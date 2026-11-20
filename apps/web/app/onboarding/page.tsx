"use client";

import type { JSX } from "react";
import { AuthWorkspace } from "../../components/auth-workspace";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { EmptyState } from "../../components/ui/studio";
import { Onboarding } from "../../features/brief/onboarding";

function BriefWizard(): JSX.Element {
  const workspace = useActiveWorkspace();
  if (workspace.role === "VIEWER")
    return (
      <EmptyState title="Channel setup is read-only">
        <p>An owner or editor can create a channel.</p>
      </EmptyState>
    );
  return <Onboarding key={workspace.id} workspace={workspace} />;
}

export default function Page(): JSX.Element {
  return (
    <AuthWorkspace>
      <BriefWizard />
    </AuthWorkspace>
  );
}
