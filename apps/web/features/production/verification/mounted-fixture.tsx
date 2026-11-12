import { useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { ProductionClient } from "../api";
import { RenderWorkspace } from "../render";
import { ProductionContext } from "../session";
import { ProductionStudio } from "../studio";
import {
  asset,
  capabilities,
  costs,
  jobId,
  production,
  render,
  renderId,
  script,
  scriptId,
  workspaceId,
} from "./fixtures";

const query = new URLSearchParams(location.search);
const role = query.get("role") === "VIEWER" ? "VIEWER" : "EDITOR";
const mode = query.get("mode") ?? "studio";
const calls: { path: string; method: string; body: unknown }[] = [];

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(input).split(`/workspaces/${workspaceId}/`)[1] ?? "";
  const method = init?.method ?? "GET";
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ path, method, body });
  let payload: unknown;
  if (path === `scene-media/jobs/${jobId}`) payload = production;
  else if (path === `scripts/${scriptId}`) payload = script;
  else if (path === "scene-media/capabilities") payload = capabilities;
  else if (path === "assets") payload = [asset];
  else if (path.startsWith("composition/jobs?")) {
    payload = {
      items: [
        {
          jobId: renderId,
          workspaceId,
          sceneMediaJobId: jobId,
          scriptId,
          scriptRevision: 2,
          channelId: script.channelId,
          status: "SUCCEEDED",
          attempt: 1,
          idempotencyKey: "render-one",
          inputFingerprint: "fingerprint",
          parentJobId: null,
          retentionDays: 90,
          cancelRequestedAt: null,
          errorCode: null,
          errorMessage: null,
          artifactCount: 1,
          createdAt: "2026-11-12T05:00:00.000Z",
          updatedAt: "2026-11-12T05:01:00.000Z",
          expiredAt: null,
        },
      ],
      page: 1,
      pageSize: 25,
      nextPage: null,
    };
  } else if (path === `usage/videos/${scriptId}`) payload = costs;
  else if (path === `composition/jobs/${renderId}`) payload = render;
  else payload = { message: `Unexpected fixture request: ${path}` };
  return new Response(JSON.stringify(payload), {
    status: "message" in (payload as Record<string, unknown>) ? 404 : 200,
    headers: { "Content-Type": "application/json" },
  });
};

Object.assign(window, { m25Fixture: { calls } });

function Fixture(): JSX.Element {
  const [revision, setRevision] = useState(0);
  const [client] = useState(
    () => new ProductionClient(workspaceId, role, new AbortController().signal),
  );
  return (
    <ProductionContext.Provider
      value={{ client, revision, refresh: () => setRevision((value) => value + 1) }}
    >
      <main style={{ maxWidth: 1440, margin: "auto", padding: 24 }}>
        {mode === "render" ? (
          <RenderWorkspace jobId={renderId} />
        ) : (
          <ProductionStudio jobId={jobId} />
        )}
      </main>
    </ProductionContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
