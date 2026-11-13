import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionApiError, ProductionClient } from "./api";
import { makeRenderInput } from "./composition";
import { assetId, pinnedRevision, production, render } from "./verification/fixtures";
import type { SceneMediaPackage, Script, ScriptRevision } from "./model";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const scriptId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000003";

afterEach(() => vi.unstubAllGlobals());

describe("ProductionClient", () => {
  it("posts pinned composition input once and refuses Viewer writes", async () => {
    const complete = {
      ...production,
      status: "SUCCEEDED" as const,
      scenes: production.scenes.map((scene) => ({
        ...scene,
        status: "SUCCEEDED" as const,
        outputs: [
          {
            kind: "IMAGE" as const,
            status: "SUCCEEDED" as const,
            assetId,
            assetVersion: 1,
            mediaType: "image/png",
            byteSize: 68,
            errorCode: null,
            errorMessage: null,
          },
        ],
      })),
    };
    const input = makeRenderInput(complete, pinnedRevision, "12345678");
    const request = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(render), { status: 200 }));
    vi.stubGlobal("fetch", request);
    await expect(
      new ProductionClient(workspaceId, "VIEWER", new AbortController().signal).startRender(
        input,
        "key",
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(request).not.toHaveBeenCalled();
    await new ProductionClient(workspaceId, "EDITOR", new AbortController().signal).startRender(
      input,
      "key",
    );
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(String((request.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      idempotencyKey: "key",
      retentionDays: 90,
      input,
    });
  });
  it("loads the exact pinned revision after the script advances and scenes are reordered", async () => {
    const revision = (number: number, title: string, sceneIds: string[]): ScriptRevision => ({
      revision: number,
      document: {
        title,
        hook: `${title} hook`,
        dialogue: "",
        cta: "CTA",
        metadata: { targetDurationSeconds: sceneIds.length * 5 },
        scenes: sceneIds.map((id, index) => ({
          id,
          startSeconds: index * 5,
          durationSeconds: 5,
          dialogue: "",
          narration: `${title} narration ${id}`,
          visualDescription: `${title} visual ${id}`,
          camera: `${title} camera`,
          audioCues: [],
        })),
      },
    });
    const latest = revision(2, "Mutable latest", ["scene-b", "scene-a"]);
    const pinned = revision(1, "Pinned production", ["scene-a", "scene-b"]);
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [latest, pinned], nextPage: null }), { status: 200 }),
      );
    vi.stubGlobal("fetch", request);
    const client = new ProductionClient(workspaceId, "VIEWER", new AbortController().signal);

    const result = await client.scriptRevision(scriptId, 1);

    expect(result).toEqual(pinned);
    expect(result.document.scenes.map((scene) => scene.id)).toEqual(["scene-a", "scene-b"]);
    expect(request).toHaveBeenCalledWith(
      `/api/v1/workspaces/${workspaceId}/scripts/${scriptId}/revisions?page=1`,
      expect.any(Object),
    );
  });

  it("blocks Viewer mutations without making a request", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const client = new ProductionClient(workspaceId, "VIEWER", new AbortController().signal);
    const script: Script = {
      id: scriptId,
      workspaceId,
      channelId: null,
      status: "APPROVED",
      currentRevision: 1,
      revisions: [
        {
          revision: 1,
          document: {
            title: "Title",
            hook: "Hook",
            dialogue: "",
            cta: "CTA",
            metadata: { targetDurationSeconds: 5 },
            scenes: [],
          },
        },
      ],
    };
    await expect(
      client.createJob(
        script,
        { image: true, video: false, narration: false, dialogue: false },
        "key",
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends the observed version and operation key for a scene mutation", async () => {
    const job: SceneMediaPackage = {
      schemaVersion: "1.0",
      jobId,
      workspaceId,
      scriptId,
      scriptRevision: 1,
      channelId: null,
      status: "FAILED",
      version: 4,
      requestedOutputs: { image: true, video: false, narration: false, dialogue: false },
      scenes: [],
    };
    const response = { ...job, status: "RUNNING", version: 5 };
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", request);
    const client = new ProductionClient(workspaceId, "EDITOR", new AbortController().signal);
    await client.mutate(job, "retry", "retry-key");
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      idempotencyKey: "retry-key",
      expectedJobVersion: 4,
    });
  });

  it("marks interrupted writes as uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection reset")));
    const client = new ProductionClient(workspaceId, "OWNER", new AbortController().signal);
    const job = {
      schemaVersion: "1.0",
      jobId,
      workspaceId,
      scriptId,
      scriptRevision: 1,
      channelId: null,
      status: "FAILED",
      version: 1,
      requestedOutputs: { image: true, video: false, narration: false, dialogue: false },
      scenes: [],
    } satisfies SceneMediaPackage;
    await expect(client.mutate(job, "retry", "key")).rejects.toEqual(
      expect.objectContaining<Partial<ProductionApiError>>({ status: 0, uncertain: true }),
    );
  });

  it.each([
    ["truncated JSON", new Response("{", { status: 200 })],
    ["an invalid DTO", new Response(JSON.stringify({ accepted: true }), { status: 200 })],
  ])("marks a successful mutation with %s as uncertain", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const client = new ProductionClient(workspaceId, "OWNER", new AbortController().signal);
    const job = {
      schemaVersion: "1.0",
      jobId,
      workspaceId,
      scriptId,
      scriptRevision: 1,
      channelId: null,
      status: "FAILED",
      version: 1,
      requestedOutputs: { image: true, video: false, narration: false, dialogue: false },
      scenes: [],
    } satisfies SceneMediaPackage;

    await expect(client.mutate(job, "retry", "saved-key")).rejects.toEqual(
      expect.objectContaining<Partial<ProductionApiError>>({ status: 502, uncertain: true }),
    );
  });
});
