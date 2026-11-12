"use client";

import { createContext, useContext, useEffect, useState, type JSX, type ReactNode } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StateMessage } from "../../components/ui/primitives";
import { ProductionClient } from "./api";

type ProductionSession = {
  client: ProductionClient;
  revision: number;
  refresh: () => void;
};
export const ProductionContext = createContext<ProductionSession | null>(null);

export function ProductionScope({ children }: { children: ReactNode }): JSX.Element {
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
  const [client, setClient] = useState<ProductionClient | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setClient(new ProductionClient(workspaceId, role, controller.signal));
    setRevision(0);
    return (): void => controller.abort();
  }, [workspaceId, role]);
  if (!client)
    return <StateMessage kind="loading" description="Opening the production workspace…" />;
  return (
    <ProductionContext.Provider
      value={{ client, revision, refresh: () => setRevision((value) => value + 1) }}
    >
      {children}
    </ProductionContext.Provider>
  );
}

export function useProduction(): ProductionSession {
  const value = useContext(ProductionContext);
  if (!value) throw new Error("useProduction must be used inside ProductionScope");
  return value;
}

export type LoadState<T> = { data: T | null; loading: boolean; error: string };
export function useLoad<T>(
  load: (client: ProductionClient) => Promise<T>,
  key: string,
): LoadState<T> {
  const { client, revision } = useProduction();
  const [state, setState] = useState<LoadState<T>>({ data: null, loading: true, error: "" });
  useEffect((): (() => void) => {
    let current = true;
    setState((previous) => ({ data: previous.data, loading: true, error: "" }));
    void load(client).then(
      (data) => {
        if (current) setState({ data, loading: false, error: "" });
      },
      (cause: unknown) => {
        if (current && !(cause instanceof DOMException && cause.name === "AbortError"))
          setState({
            data: null,
            loading: false,
            error:
              cause instanceof Error ? cause.message : "The production data could not be loaded.",
          });
      },
    );
    return (): void => {
      current = false;
    };
  }, [client, key, revision]);
  return state;
}
