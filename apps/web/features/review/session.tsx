"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StateMessage } from "../../components/ui/primitives";
import { ReviewClient } from "./api";
export const ReviewContext = createContext<{
  client: ReviewClient;
  revision: number;
  refresh: () => void;
} | null>(null);
export function ReviewScope({ children }: { children: ReactNode }): JSX.Element {
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
  const [client, setClient] = useState<ReviewClient | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setClient(new ReviewClient(workspaceId, role, controller.signal));
    return (): void => controller.abort();
  }, [workspaceId, role]);
  if (!client) return <StateMessage kind="loading" description="Opening review workspace…" />;
  return (
    <ReviewContext.Provider value={{ client, revision, refresh: () => setRevision((v) => v + 1) }}>
      {children}
    </ReviewContext.Provider>
  );
}
export function useReview(): NonNullable<React.ContextType<typeof ReviewContext>> {
  const context = useContext(ReviewContext);
  if (!context) throw new Error("Review requires an authenticated workspace.");
  return context;
}
export function useLoad<T>(
  load: (client: ReviewClient) => Promise<T>,
  key: string,
): { data: T | null; loading: boolean; error: string } {
  const { client, revision } = useReview();
  const loader = useRef(load);
  loader.current = load;
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    loading: boolean;
    error: string;
  }>({ key, data: null, loading: true, error: "" });
  useEffect(() => {
    let current = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : null,
      loading: true,
      error: "",
    }));
    void loader.current(client).then(
      (data) => {
        if (current && !client.signal.aborted) setState({ key, data, loading: false, error: "" });
      },
      (cause: unknown) => {
        if (current && !client.signal.aborted)
          setState({
            key,
            data: null,
            loading: false,
            error: cause instanceof Error ? cause.message : "Review could not be loaded.",
          });
      },
    );
    return (): void => {
      current = false;
    };
  }, [client, revision, key]);
  return state.key === key ? state : { data: null, loading: true, error: "" };
}
