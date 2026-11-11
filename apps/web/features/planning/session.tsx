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
import { draftEdited, registerDraft } from "../../components/studio-navigation";
import { Alert, Button, StateMessage } from "../../components/ui/primitives";
import { PlanningClient, pendingSave, clearPendingSave } from "./model";
export const PlanningContext = createContext<{
  client: PlanningClient;
  revision: number;
  refresh: () => void;
  suspended: boolean;
} | null>(null);
export function PlanningScope({ children }: { children: ReactNode }): JSX.Element {
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
  const [client, setClient] = useState<PlanningClient | null>(null);
  const [revision, setRevision] = useState(0);
  const [uncertain, setUncertain] = useState(false);
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const api = new PlanningClient(workspaceId, role, controller.signal, () => setSuspended(true));
    setClient(api);
    return (): void => controller.abort();
  }, [workspaceId, role]);
  const refresh = (): void => {
    setRevision((v) => v + 1);
    setUncertain(Boolean(pendingSave(workspaceId)));
  };
  useEffect(() => {
    const recover = (): void => {
      if (pendingSave(workspaceId)) {
        setUncertain(true);
        setRevision((v) => v + 1);
      }
    };
    recover();
    window.addEventListener("focus", recover);
    window.addEventListener("pageshow", recover);
    return (): void => {
      window.removeEventListener("focus", recover);
      window.removeEventListener("pageshow", recover);
    };
  }, [workspaceId]);
  if (!client)
    return <StateMessage kind="loading" description="Opening your planning workspace…" />;
  return (
    <PlanningContext.Provider value={{ client, revision, refresh, suspended }}>
      {suspended && (
        <Alert tone="danger" title="Session or access changed">
          Writes are disabled. Sign out and sign in again to refresh your verified workspace
          permissions.
        </Alert>
      )}
      {uncertain && (
        <Alert tone="warning" title="Reconcile an interrupted save">
          The server may have committed the earlier request. Current data is being fetched; inspect
          it before retrying.<Button onClick={refresh}>Refresh saved data</Button>
          <Button
            tone="secondary"
            onClick={() => {
              clearPendingSave(workspaceId);
              setUncertain(false);
            }}
          >
            I have compared the saved state
          </Button>
        </Alert>
      )}
      {children}
    </PlanningContext.Provider>
  );
}
export function usePlanning(): {
  client: PlanningClient;
  revision: number;
  refresh: () => void;
  suspended: boolean;
} {
  const context = useContext(PlanningContext);
  if (!context) throw new Error("Planning requires authenticated workspace context.");
  return context;
}
export function useLoad<T>(
  load: (client: PlanningClient) => Promise<T>,
  key: string,
): { data: T | null; error: string; loading: boolean } {
  const { client, revision } = usePlanning();
  const loader = useRef(load);
  loader.current = load;
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string;
    loading: boolean;
  }>({ key, data: null, error: "", loading: true });
  useEffect(() => {
    let current = true;
    setState((s) => ({ key, data: s.key === key ? s.data : null, error: "", loading: true }));
    void loader
      .current(client)
      .then((data) => {
        if (current && !client.signal.aborted) setState({ key, data, error: "", loading: false });
      })
      .catch((error: unknown) => {
        if (current && !client.signal.aborted)
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : null,
            error: message(error),
            loading: false,
          }));
      });
    return (): void => {
      current = false;
    };
  }, [client, key, revision]);
  return state.key === key ? state : { data: null, error: "", loading: true };
}
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed. Please try again.";
export function useDirty(id: string, dirty: boolean, discard: () => void): void {
  const latest = useRef(discard);
  latest.current = discard;
  useEffect(() => {
    if (dirty) {
      draftEdited();
      return registerDraft(id, () => latest.current());
    }
  }, [id, dirty]);
}
