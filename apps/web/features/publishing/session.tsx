"use client";

import { createContext, useContext, useEffect, useMemo, type JSX, type ReactNode } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { PublishingClient } from "./api";

const PublishingContext = createContext<PublishingClient | null>(null);

export function PublishingScope({ children }: { children: ReactNode }): JSX.Element {
  const workspace = useActiveWorkspace();
  const session = useMemo(() => {
    const controller = new AbortController();
    return {
      controller,
      client: new PublishingClient(workspace.id, workspace.role, controller.signal),
    };
  }, [workspace.id, workspace.role]);
  useEffect(() => (): void => session.controller.abort(), [session]);
  return (
    <PublishingContext.Provider value={session.client}>{children}</PublishingContext.Provider>
  );
}

export function usePublishingClient(): PublishingClient {
  const client = useContext(PublishingContext);
  if (!client) throw new Error("usePublishingClient must be used inside PublishingScope");
  return client;
}
