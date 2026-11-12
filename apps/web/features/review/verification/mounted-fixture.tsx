import { useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "../../../components/app-shell";
import { ReviewClient } from "../api";
import { WorkspaceProvider } from "../../../components/studio-workspace-context";
import { Button } from "../../../components/ui/primitives";
import { ReviewScope } from "../session";
import { ReviewContext } from "../session";
import { ReviewDetail, ReviewQueue } from "../workspace";
import type { Decision, Run } from "../model";
import { render, review, runId, scorecard, workspaceId } from "./fixtures";
const query = new URLSearchParams(location.search);
const mode = query.get("mode") ?? "detail";
const role =
  query.get("role") === "VIEWER" ? "VIEWER" : query.get("role") === "OWNER" ? "OWNER" : "EDITOR";
let current: Run = structuredClone(review);
let failedRead = false;
if (mode === "blocked") {
  current.status = "BLOCKED";
  current.gateSummary[0]!.passed = false;
}
if (mode === "missing") current.gateSummary = [];
if (mode === "ai" || mode === "auto") {
  current.scorecard = scorecard;
  current.limitations = [];
}
if (mode === "auto") {
  current.status = "AUTO_APPROVED";
  current.policySnapshot.mode = "AUTO";
}
if (mode === "history") {
  current.status = "CHANGES_REQUESTED";
  current.decisions = [
    {
      id: "old-decision",
      action: "REQUEST_CHANGES",
      reason: "Improve the opening scene",
      overrideReason: "Rework pacing",
      actorUserId: "persisted-reviewer-id",
      createdAt: review.createdAt,
    },
  ];
  current.regenerationRequests = [
    {
      id: "request-1",
      stage: "SCENE",
      sceneId: "scene-one",
      attempt: 2,
      createdAt: review.createdAt,
    },
    { id: "request-2", stage: "SCRIPT", sceneId: null, attempt: 1, createdAt: review.createdAt },
    { id: "request-3", stage: "RENDER", sceneId: null, attempt: 1, createdAt: review.createdAt },
  ];
}
const calls: { path: string; method: string }[] = [];
Object.assign(window, { m26Fixture: { calls } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(input);
  const method = init?.method ?? "GET";
  calls.push({ path, method });
  if (mode === "isolation" && path.endsWith("/queue")) {
    if (!path.includes(workspaceId)) return new Response("[]");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    return new Response(JSON.stringify([current]));
  }
  if (method === "POST") {
    if (mode === "conflict") {
      current = { ...current, status: "SUPERSEDED", supersededAt: review.createdAt };
      return new Response("{}", { status: 409 });
    }
    const decision = JSON.parse(String(init?.body)) as Decision;
    current = {
      ...current,
      status:
        decision.action === "APPROVE"
          ? "APPROVED"
          : decision.action === "REJECT"
            ? "REJECTED"
            : "CHANGES_REQUESTED",
      decisions: [
        ...current.decisions,
        {
          id: "saved-decision",
          action: decision.action,
          reason: decision.reason,
          overrideReason: decision.overrideReason ?? null,
          actorUserId: "persisted-human-id",
          createdAt: review.createdAt,
        },
      ],
      regenerationRequests: decision.regeneration
        ? [
            {
              id: "saved-request",
              stage: decision.regeneration.stage,
              sceneId: decision.regeneration.sceneId ?? null,
              attempt: 1,
              createdAt: review.createdAt,
            },
          ]
        : [],
    };
    return new Response(mode === "ambiguous" ? "{" : JSON.stringify(current), { status: 200 });
  }
  if (mode === "error" && !failedRead) {
    failedRead = true;
    return new Response("{}", { status: 503 });
  }
  let payload: unknown;
  if (path.endsWith("/queue")) payload = mode === "empty" ? [] : [current];
  else if (path.includes("/composition/jobs/")) payload = render;
  else if (path.endsWith("/status"))
    payload = { renderJobId: render.id, status: current.status, gateSummary: current.gateSummary };
  else payload = current;
  return new Response(JSON.stringify(payload), { status: 200 });
};
function IsolationFixture(): JSX.Element {
  const [selected, setSelected] = useState(workspaceId);
  return (
    <AppShell>
      <Button onClick={() => setSelected("second-workspace")}>Switch fixture workspace</Button>
      <WorkspaceProvider workspace={{ id: selected, name: selected, role: "EDITOR" }}>
        <ReviewScope>
          <ReviewQueue />
        </ReviewScope>
      </WorkspaceProvider>
    </AppShell>
  );
}
function Fixture(): JSX.Element {
  const [client] = useState(
    () => new ReviewClient(workspaceId, role, new AbortController().signal),
  );
  const [revision, setRevision] = useState(0);
  return (
    <AppShell>
      <p>Controlled M26 browser fixture</p>
      <ReviewContext.Provider
        value={{ client, revision, refresh: () => setRevision((v) => v + 1) }}
      >
        {["queue", "empty", "error"].includes(mode) ? (
          <ReviewQueue />
        ) : (
          <ReviewDetail runId={runId} />
        )}
      </ReviewContext.Provider>
    </AppShell>
  );
}
createRoot(document.getElementById("root")!).render(
  mode === "isolation" ? <IsolationFixture /> : <Fixture />,
);
