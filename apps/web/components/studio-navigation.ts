/** Explicit intents are shared by links, session actions, selection and programmatic routing. */
export type NavigationIntent = "route" | "history" | "workspace" | "logout" | "selection";
type Draft = { discard: () => void };
const drafts = new Map<string, Draft>();
let approvedUrl: string | null = null;
let allowUnload = false;
export function registerDraft(id: string, discard: () => void): () => void {
  approvedUrl = null;
  allowUnload = false;
  drafts.set(id, { discard });
  return (): void => {
    drafts.delete(id);
  };
}
export function navigationCompleted(): void {
  approvedUrl = null;
  allowUnload = false;
}
export function draftEdited(): void {
  approvedUrl = null;
  allowUnload = false;
}
export function hasUnsavedChanges(): boolean {
  return drafts.size > 0;
}
export function requestNavigationIntent(intent: NavigationIntent, destination?: string): boolean {
  if (destination && approvedUrl === new URL(destination, window.location.href).href) return true;
  if (!drafts.size) return true;
  const label =
    intent === "logout"
      ? "signing out"
      : intent === "workspace"
        ? "switching workspace"
        : intent === "selection"
          ? "changing selection"
          : "leaving this page";
  if (!window.confirm(`Discard unsaved changes before ${label}?`)) return false;
  for (const draft of [...drafts.values()]) draft.discard();
  if (destination) approvedUrl = new URL(destination, window.location.href).href;
  allowUnload = true;
  return true;
}
/** Call this before a router.push/replace or any other programmatic route transition. */
export function navigateWithIntent(destination: string, navigate: (href: string) => void): boolean {
  if (!requestNavigationIntent("route", destination)) return false;
  navigate(destination);
  return true;
}
type NavigationEvent = Event & { destination: { url: string }; navigationType: string };
type NavigationTarget = EventTarget;
export function installNavigationGuard(target: Window): () => void {
  const navigation = (target as Window & { navigation?: NavigationTarget }).navigation;
  const unload = (event: BeforeUnloadEvent): void => {
    if (drafts.size && !allowUnload) {
      event.preventDefault();
      event.returnValue = "";
    }
    allowUnload = false;
  };
  const navigate = (event: Event): void => {
    const route = event as NavigationEvent;
    if (route.destination.url === target.location.href || route.navigationType === "traverse")
      return;
    if (
      route.cancelable &&
      !requestNavigationIntent(
        route.navigationType === "traverse" ? "history" : "route",
        route.destination.url,
      )
    )
      event.preventDefault();
  };
  // History traversal uses indexed rollback in every engine, including non-cancellable browser-UI
  // traversals. Capture runs before
  // the router's bubble listener, and a rejected traversal is rolled back without rendering it.
  const originalPush = target.history.pushState;
  const originalReplace = target.history.replaceState;
  const key = "__reelforgeEntry";
  const entry = (state: unknown): number | null =>
    typeof state === "object" && state !== null && key in state && typeof state[key] === "number"
      ? state[key]
      : null;
  let index = entry(target.history.state) ?? 0;
  let rollingBack = false;
  originalReplace.call(target.history, { ...target.history.state, [key]: index }, "");
  const push: History["pushState"] = function (
    state: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    if (!navigation && url && !requestNavigationIntent("route", String(url))) return;
    index += 1;
    originalPush.call(
      target.history,
      { ...(typeof state === "object" && state !== null ? state : {}), [key]: index },
      unused,
      url,
    );
  };
  const replace: History["replaceState"] = function (
    state: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    if (
      !navigation &&
      url &&
      new URL(String(url), target.location.href).href !== target.location.href &&
      !requestNavigationIntent("route", String(url))
    )
      return;
    originalReplace.call(
      target.history,
      { ...(typeof state === "object" && state !== null ? state : {}), [key]: index },
      unused,
      url,
    );
  };
  const pop = (event: PopStateEvent): void => {
    const next = entry(event.state);
    if (rollingBack) {
      rollingBack = false;
      event.stopImmediatePropagation();
      return;
    }
    if (next !== null && !requestNavigationIntent("history", target.location.href)) {
      event.stopImmediatePropagation();
      rollingBack = true;
      target.history.go(index - next);
      return;
    }
    if (next !== null) index = next;
  };
  target.history.pushState = push;
  target.history.replaceState = replace;
  navigation?.addEventListener("navigate", navigate);
  target.addEventListener("popstate", pop, true);
  target.addEventListener("beforeunload", unload);
  return (): void => {
    navigation?.removeEventListener("navigate", navigate);
    target.removeEventListener("popstate", pop, true);
    target.removeEventListener("beforeunload", unload);
    if (target.history.pushState === push) target.history.pushState = originalPush;
    if (target.history.replaceState === replace) target.history.replaceState = originalReplace;
    approvedUrl = null;
    allowUnload = false;
  };
}
