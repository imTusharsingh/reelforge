/** Mounted browser test fixture. This entry is bundled only by mounted-browser.mjs. */
import { useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { ChannelsClient } from "../api";
import { ChannelsScope, ClientContext, ActionForm, useResource } from "../ui";
import { GroupSeriesAssignment, PublishedMember } from "../character-panel";
import { SnapshotsPanel } from "../content-panels";
import { ConfigurationPanel } from "../configuration-panel";
import { characterFields } from "../catalog";
import { type ApiObject, type Role } from "../model";
import {
  hasUnsavedChanges,
  installNavigationGuard,
  navigateWithIntent,
  requestNavigationIntent,
} from "../../../components/studio-navigation";
import {
  ids,
  channel,
  series,
  characterVersion,
  promptTemplate,
  promptVersion,
  snapshot,
} from "./fixtures";
let savedName = channel.name;
let selectedSnapshot = ids.snapshot;
let activePrompt = ids.version;
const calls: { method: string; path: string; body: ApiObject }[] = [];
let pendingResolve: ((r: Response) => void) | null = null;
let deferSave = false;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const path =
    url.split(`/workspaces/${ids.workspace}/`)[1] ??
    url.split(`/workspaces/${ids.otherWorkspace}/`)[1] ??
    "";
  const method = init?.method ?? "GET";
  const body: ApiObject = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  calls.push({ method, path, body });
  let result: unknown = {};
  if (path === `channels/${ids.channel}`) {
    if (method === "PATCH") savedName = String(body.name);
    result = { ...channel, name: savedName, activeSnapshotId: selectedSnapshot };
  } else if (path === `channels/${ids.channel}/series`) result = [series];
  else if (path === `characters/${ids.character}/versions`)
    result = [
      characterVersion,
      { ...characterVersion, id: ids.secondVersion, version: 2, status: "DRAFT" },
    ];
  else if (path.startsWith(`channels/${ids.channel}/snapshots`)) {
    if (method === "POST") {
      selectedSnapshot = ids.secondSnapshot;
      result = { ...channel, activeSnapshotId: selectedSnapshot };
    } else result = [snapshot, { ...snapshot, id: ids.secondSnapshot, version: 2 }];
  } else if (path === `character-groups/${ids.group}/members`)
    result = { id: ids.member, workspaceId: ids.workspace, groupId: ids.group, ...body };
  else if (path === `character-groups/${ids.group}/assignments`)
    result = {
      id: ids.assignment,
      workspaceId: ids.workspace,
      groupId: ids.group,
      channelId: null,
      ...body,
    };
  else if (path === "config")
    result = {
      activeSnapshot: {
        ...snapshot,
        id: selectedSnapshot,
        version: selectedSnapshot === ids.snapshot ? 1 : 2,
      },
      config: {},
      layers: [],
      locks: [],
    };
  else if (path === "config/snapshots")
    result = [snapshot, { ...snapshot, id: ids.secondSnapshot, version: 2 }];
  else if (path.startsWith("config/snapshots/")) {
    selectedSnapshot = ids.secondSnapshot;
    result = { ...snapshot, id: selectedSnapshot, version: 2 };
  } else if (path === "prompts/templates")
    result = [
      {
        ...promptTemplate,
        activeVersionId: activePrompt,
        activeVersion: {
          ...promptVersion,
          id: activePrompt,
          version: activePrompt === ids.version ? 1 : 2,
        },
      },
    ];
  else if (path.includes("/versions") || path.endsWith("/rollback")) {
    const second = { ...promptVersion, id: ids.secondVersion, version: 2 };
    if (method === "POST") {
      activePrompt = String(body.versionId ?? ids.secondVersion);
      result = activePrompt === ids.version ? promptVersion : second;
    } else result = [promptVersion, second];
  } else if (path.endsWith("generation-snapshots") || path.endsWith("bundle-snapshots"))
    result = [];
  else if (path === "config/resolve") result = { config: {}, layers: [], locks: [] };
  else if (path === "prompts/preview") result = { config: {}, template: {}, bundle: {} };
  const response = new Response(JSON.stringify(result), {
    status: method === "GET" ? 200 : 201,
    headers: { "Content-Type": "application/json" },
  });
  if (deferSave && method === "PATCH")
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  return response;
};
let setFixtureInitial: (value: string) => void = () => {};
let setFixtureRole: (role: Role) => void = () => {};
let switchContext: () => void = () => {};
declare global {
  interface Window {
    m23Fixture: {
      hasDraft: () => boolean;
      calls: typeof calls;
      ids: typeof ids;
      setInitial: (value: string) => void;
      setRole: (role: Role) => void;
      switchContext: () => void;
      defer: () => void;
      release: () => void;
      programmatic: () => boolean;
    };
  }
}
function LivePanels(): JSX.Element {
  const state = useResource(`channels/${ids.channel}`, false, "channel");
  const data = state.data[0];
  return (
    <>
      {data && (
        <>
          <p data-testid="active-channel">{String(data.activeSnapshotId)}</p>
          <SnapshotsPanel channelId={ids.channel} channel={data} />
        </>
      )}
      <ConfigurationPanel channelId={ids.channel} />
    </>
  );
}
function Fixture(): JSX.Element {
  const [initial, setInitial] = useState("Science studio");
  const [role, setRole] = useState<Role>("OWNER");
  const [workspace, setWorkspace] = useState(ids.workspace);
  const [controller, setController] = useState(() => new AbortController());
  setFixtureInitial = setInitial;
  setFixtureRole = (next): void => {
    controller.abort();
    setController(new AbortController());
    setRole(next);
  };
  switchContext = (): void => {
    controller.abort();
    setController(new AbortController());
    setWorkspace((w) => (w === ids.workspace ? ids.otherWorkspace : ids.workspace));
  };
  const client = new ChannelsClient(workspace, controller.signal, role);
  return (
    <ChannelsScope key={`${workspace}-${role}`} workspaceId={workspace} role={role}>
      <ClientContext.Provider value={client}>
        <h1>Mounted M23 test fixture</h1>
        <p data-testid="workspace">{workspace}</p>
        <button
          aria-label="Choose another workspace"
          onClick={() => {
            if (requestNavigationIntent("workspace")) switchContext();
          }}
        >
          ↔
        </button>
        <button
          aria-label="End session"
          onClick={() => {
            if (requestNavigationIntent("logout")) setFixtureRole("UNKNOWN");
          }}
        >
          ×
        </button>
        <a
          href="/destination"
          onClick={(e) => {
            e.preventDefault();
            navigateWithIntent("/destination", (url) => history.pushState({}, "", url));
          }}
        >
          Navigate away
        </a>
        <ActionForm
          title="Mounted brand editor"
          fields={[{ key: "name", label: "Test channel name" }]}
          initial={{ name: initial }}
          path={`channels/${ids.channel}`}
          method="PATCH"
          submitLabel="Save test channel"
        />
        <ActionForm
          title="Mounted character editor"
          fields={characterFields}
          initial={{ name: "Nova", personality: { traits: ["curious"], energy: "warm" } }}
          path="characters"
          submitLabel="Save test character"
        />
        <GroupSeriesAssignment groupId={ids.group} channelId={ids.channel} onSaved={() => {}} />
        <PublishedMember groupId={ids.group} characterId={ids.character} onSaved={() => {}} />
        <LivePanels />
      </ClientContext.Provider>
    </ChannelsScope>
  );
}
installNavigationGuard(window);
window.m23Fixture = {
  hasDraft: (): boolean => hasUnsavedChanges(),
  calls,
  ids,
  setInitial: (value): void => setFixtureInitial(value),
  setRole: (role): void => setFixtureRole(role),
  switchContext: (): void => switchContext(),
  defer: (): void => {
    deferSave = true;
  },
  release: (): void => {
    deferSave = false;
    pendingResolve?.(
      new Response(JSON.stringify({ ...channel, name: savedName }), { status: 200 }),
    );
  },
  programmatic: (): boolean =>
    navigateWithIntent("/programmatic", (url) => history.pushState({}, "", url)),
};
createRoot(document.getElementById("root")!).render(<Fixture />);
