/** Isolated browser fixture: requests are deterministic, in-memory test doubles, never providers. */
import { useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { PlanningContext, PendingSaveRecovery } from "../session";
import { PlanningClient, pendingSave, type Script, type Idea } from "../model";
import { ScriptEditor, ScriptWorkspace } from "../script-workspace";
import { IdeaForm } from "../idea-form";
import { PlanningLibrary } from "../library";
import { idea, script } from "./fixtures";
import {
  installNavigationGuard,
  requestNavigationIntent,
} from "../../../components/studio-navigation";
const mode = new URLSearchParams(location.search).get("mode") ?? "script";
const role = new URLSearchParams(location.search).get("role") === "VIEWER" ? "VIEWER" : "EDITOR";
let saved = structuredClone(script);
let savedIdea = structuredClone(idea);
const calls: { path: string; method: string; body: unknown }[] = [];
let fail = 0;
let failReads = false;
let pauseReads = false;
let releaseReads: (() => void) | undefined;
let loseCommitResponse = false;
if (mode === "recovery")
  sessionStorage.setItem("reelforge.planning.pending:workspace-one", "ideas/idea-one");
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(input).split("/workspaces/workspace-one/")[1] ?? "";
  const method = init?.method ?? "GET";
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ path, method, body });
  if (method === "GET" && pauseReads)
    await new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
  if (method === "GET" && failReads)
    return new Response(JSON.stringify({ message: "Read unavailable" }), { status: 503 });
  if (method !== "GET" && fail)
    return new Response(JSON.stringify({ message: "Save interrupted" }), { status: fail });
  let result: unknown = [];
  if (path === "scripts/script-one") result = saved;
  else if (path === "scripts/script-one/revisions" && method === "POST") {
    saved = {
      ...saved,
      currentRevision: saved.currentRevision + 1,
      status: "REVISION_PENDING",
      revisions: [
        {
          revision: saved.currentRevision + 1,
          document: body as Script["revisions"][number]["document"],
        },
      ],
    };
    result = saved;
  } else if (path.includes("/revisions?")) result = { items: saved.revisions, nextPage: null };
  else if (path.startsWith("scripts?")) result = { items: [saved], nextPage: null };
  else if (path.startsWith("ideas?")) result = [savedIdea];
  else if (path === "ideas/idea-one" && method === "PATCH") {
    savedIdea = { ...savedIdea, ...(body as Partial<Idea>), updatedAt: "2026-11-11T12:00:00.000Z" };
    result = savedIdea;
    if (loseCommitResponse)
      return new Response(JSON.stringify({ message: "Response lost after commit" }), {
        status: 503,
      });
  } else if (path === "channels")
    result = [{ id: "channel-one", workspaceId: idea.workspaceId, name: "Creator studio" }];
  else if (path === "characters")
    result = [{ id: "char-one", workspaceId: idea.workspaceId, name: "Mira" }];
  else if (path === "characters/char-one/versions")
    result = [
      {
        id: "version-one",
        workspaceId: idea.workspaceId,
        characterId: "char-one",
        status: "PUBLISHED",
        version: 1,
      },
      { id: "draft-version", characterId: "char-one", status: "DRAFT", version: 2 },
    ];
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
let rerender: (() => void) | undefined;
Object.assign(window, {
  m24Fixture: {
    calls,
    failReads: (value = true): void => {
      failReads = value;
    },
    pauseReads: (): void => {
      pauseReads = true;
    },
    releaseReads: (): void => {
      pauseReads = false;
      releaseReads?.();
    },
    loseCommitResponse: (): void => {
      loseCommitResponse = true;
    },
    fail: (status: number): void => {
      fail = status;
    },
    remote: (): void => {
      saved = {
        ...saved,
        currentRevision: 2,
        revisions: [
          {
            ...saved.revisions[0]!,
            revision: 2,
            document: { ...saved.revisions[0]!.document, title: "Remote revision title" },
          },
        ],
      };
      rerender?.();
    },
  },
});
installNavigationGuard(window);
function Fixture(): JSX.Element {
  const [revision, setRevision] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const [client] = useState(
    () =>
      new PlanningClient(idea.workspaceId, role, new AbortController().signal, () =>
        setSuspended(true),
      ),
  );
  rerender = (): void => setRevision((v) => v + 1);
  return (
    <PlanningContext.Provider
      value={{ client, revision, refresh: () => setRevision((v) => v + 1), suspended }}
    >
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "auto" }}>
        <button onClick={() => requestNavigationIntent("workspace")}>
          Test workspace navigation
        </button>
        {pendingSave(idea.workspaceId) && (
          <PendingSaveRecovery
            client={client}
            revision={revision}
            onReconciled={() => setRevision((v) => v + 1)}
          />
        )}
        {mode === "idea" || mode === "recovery" ? (
          <IdeaForm idea={savedIdea} onSaved={() => setRevision((v) => v + 1)} />
        ) : mode === "library" ? (
          <PlanningLibrary />
        ) : mode === "route" ? (
          <ScriptWorkspace scriptId={saved.id} />
        ) : (
          <ScriptEditor script={saved} />
        )}
      </main>
    </PlanningContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
