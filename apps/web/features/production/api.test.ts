import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionApiError, ProductionClient } from "./api";
import type { SceneMediaPackage, Script } from "./model";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const scriptId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000003";

afterEach(() => vi.unstubAllGlobals());

describe("ProductionClient", () => {
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
});
