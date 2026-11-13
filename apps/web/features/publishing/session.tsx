"use client";

import { createContext, useContext, useEffect, useState, type JSX, type ReactNode } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StateMessage } from "../../components/ui/primitives";
import { PublishingClient } from "./api";

const PublishingContext = createContext<PublishingClient | null>(null);

export function PublishingScope({ children }: { children: ReactNode }): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <Scope
      key={`${workspace.id}:${workspace.role}`}
      workspaceId={workspace.id}
      role={workspace.role}
    >
      {children}
    </Scope>
  );
}

function Scope({
  workspaceId,
  role,
  children,
}: {
  workspaceId: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
  children: ReactNode;
}): JSX.Element {
  const [client, setClient] = useState<PublishingClient | null>(null);
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setClient(new PublishingClient(workspaceId, role, controller.signal));
    return (): void => controller.abort();
  }, [workspaceId, role]);
  if (!client)
    return <StateMessage kind="loading" description="Opening the publishing workspace…" />;
  return <PublishingContext.Provider value={client}>{children}</PublishingContext.Provider>;
}

export function usePublishingClient(): PublishingClient {
  const client = useContext(PublishingContext);
  if (!client) throw new Error("usePublishingClient must be used inside PublishingScope");
  return client;
}
