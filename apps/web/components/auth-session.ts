import { ApiError, api, type Workspace } from "../lib/api";
import {
  isAlreadyInvalidSession,
  resolveCurrentRequest,
  sessionFailureMessage,
} from "../lib/session-policy";
type SessionState = {
  view: "auth" | "onboarding" | "studio";
  workspaces: Workspace[];
  selected: Workspace | null;
  booting: boolean;
  sessionError: string;
  logoutError: string;
};
/** Per-mounted-boundary session controller. Generation fences discard stale workspace responses. */
export class AuthSession {
  private state: SessionState = {
    view: "auth",
    workspaces: [],
    selected: null,
    booting: true,
    sessionError: "",
    logoutError: "",
  };
  private readonly listeners = new Set<() => void>();
  public generation = 0;
  public readonly snapshot = (): SessionState => this.state;
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private clear(): void {
    this.generation++;
    window.localStorage.removeItem("reelforge.activeWorkspace");
    this.update({ workspaces: [], selected: null, view: "auth", booting: false });
  }
  public readonly refresh = async (expected = this.generation): Promise<Workspace[] | null> => {
    try {
      const items = await resolveCurrentRequest(
        api.listWorkspaces(),
        () => this.generation,
        expected,
      );
      if (items !== null) this.update({ workspaces: items });
      return items;
    } catch (error) {
      if (
        this.generation === expected &&
        (isAlreadyInvalidSession(error) || (error instanceof ApiError && error.status === 403))
      ) {
        this.clear();
        this.update({
          sessionError:
            error instanceof ApiError && error.status === 403
              ? "Your workspace access was denied."
              : sessionFailureMessage(error),
        });
        return null;
      }
      throw error;
    }
  };
  public readonly load = async (): Promise<void> => {
    const expected = this.generation;
    try {
      const items = await this.refresh(expected);
      if (items === null) return;
      const selected = items.find(
        (item) => item.id === window.localStorage.getItem("reelforge.activeWorkspace"),
      );
      this.update(selected ? { selected, view: "studio" } : { view: "onboarding" });
    } catch (error) {
      if (expected !== this.generation) return;
      this.update({
        view: "auth",
        sessionError: error instanceof ApiError && error.status !== 401 ? error.message : "",
      });
    } finally {
      if (expected === this.generation) this.update({ booting: false });
    }
  };
  public readonly authenticated = async (): Promise<void> => {
    this.update({ sessionError: "" });
    const expected = ++this.generation;
    try {
      if ((await this.refresh(expected)) !== null && expected === this.generation)
        this.update({ view: "onboarding" });
    } catch (error) {
      if (expected === this.generation)
        this.update({
          sessionError: `Your session is active, but workspaces could not be loaded: ${error instanceof ApiError ? error.message : "Something went wrong. Try again."}`,
        });
    }
  };
  public readonly choose = (workspace: Workspace): void => {
    this.generation++;
    window.localStorage.setItem("reelforge.activeWorkspace", workspace.id);
    this.update({ selected: workspace, view: "studio" });
  };
  public readonly switchWorkspace = (): void => {
    this.generation++;
    this.update({ selected: null, view: "onboarding" });
  };
  public readonly retry = async (): Promise<void> => {
    const expected = this.generation;
    this.update({ sessionError: "", booting: true });
    try {
      if ((await this.refresh(expected)) !== null && expected === this.generation)
        this.update({ view: "onboarding" });
    } catch (error) {
      if (expected === this.generation)
        this.update({
          sessionError:
            error instanceof ApiError ? error.message : "Something went wrong. Try again.",
        });
    } finally {
      if (expected === this.generation) this.update({ booting: false });
    }
  };
  public readonly logout = async (): Promise<void> => {
    this.update({ logoutError: "" });
    try {
      await api.logout();
      this.clear();
    } catch (error) {
      if (isAlreadyInvalidSession(error)) this.clear();
      else this.update({ logoutError: sessionFailureMessage(error) });
    }
  };
}
