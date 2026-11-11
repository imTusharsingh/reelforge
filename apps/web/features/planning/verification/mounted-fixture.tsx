/** Isolated browser fixture: requests are deterministic, in-memory test doubles, never providers. */
import { useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { PlanningContext, PendingSaveRecovery } from "../session";
import { PlanningClient, pendingSave, type Script, type Idea } from "../model";
import { ScriptEditor, ScriptWorkspace } from "../script-workspace";
import { IdeaWorkspace } from "../idea-workspace";
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
const persistedHistory = structuredClone(script.revisions);
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
  const conflict = (): Response =>
    new Response(JSON.stringify({ message: "Version changed" }), { status: 409 });
  const posted = body as {
    expectedRevision?: number;
    document?: Script["revisions"][number]["document"];
    expectedStatus?: string;
    expectedUpdatedAt?: string;
    status?: Idea["status"];
  };

  if (path === "scripts/script-one") result = saved;
  else if (path === "scripts/script-one/revisions" && method === "POST") {
    if (posted.expectedRevision !== saved.currentRevision) return conflict();
    saved = {
      ...saved,
      currentRevision: saved.currentRevision + 1,
      status: "REVISION_PENDING",
      revisions: [
        {
          revision: saved.currentRevision + 1,
          document: posted.document!,
        },
      ],
    };
    persistedHistory.unshift(saved.revisions[0]!);
    result = saved;
  } else if (path === "scripts/script-one/approve" && method === "POST") {
    if (posted.expectedRevision !== saved.currentRevision) return conflict();
    saved = { ...saved, status: "APPROVED" };
    result = {
      scriptId: saved.id,
      revision: saved.currentRevision,
      approvedIdeaSnapshotId: "snapshot-one",
      document: saved.revisions[0]!.document,
    };
  } else if (path === "scripts/script-one/export")
    result = {
      scriptId: saved.id,
      revision: saved.currentRevision,
      approvedIdeaSnapshotId: "snapshot-one",
      document: saved.revisions[0]!.document,
    };
  else if (path === "ideas/idea-one/status" && method === "PATCH") {
    if (
      posted.expectedStatus !== savedIdea.status ||
      posted.expectedUpdatedAt !== savedIdea.updatedAt
    )
      return conflict();
    savedIdea = { ...savedIdea, status: posted.status!, updatedAt: "2026-11-12T03:00:00.000Z" };
    result = savedIdea;
  } else if (path === "ideas/approved/idea-one") {
    if (savedIdea.status !== "APPROVED") return new Response("{}", { status: 404 });
    result = {
      id: "snapshot-one",
      ideaId: savedIdea.id,
      workspaceId: savedIdea.workspaceId,
      checksumSha256: "a".repeat(64),
    };
  } else if (path.includes("/revisions?")) result = { items: persistedHistory, nextPage: null };
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
    remoteIdea: (): void => {
      savedIdea = { ...savedIdea, status: "BACKLOG", updatedAt: "2026-11-12T02:00:00.000Z" };
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
        ) : mode === "idea-route" ? (
          <IdeaWorkspace ideaId={savedIdea.id} />
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
