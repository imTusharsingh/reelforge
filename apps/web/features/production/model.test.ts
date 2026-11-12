import { describe, expect, it } from "vitest";
import {
  artifactPath,
  mediaPath,
  parseCapabilities,
  parseCost,
  parsePackage,
  parseSceneJobs,
} from "./model";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const scriptId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000003";

describe("production boundary validation", () => {
  it("accepts persisted scene packages and rejects foreign workspace data", () => {
    const value = {
      schemaVersion: "1.0",
      jobId,
      workspaceId,
      scriptId,
      scriptRevision: 2,
      channelId: null,
      status: "SUCCEEDED",
      version: 3,
      idempotencyKey: "create-1",
      configSnapshotId: "40000000-0000-4000-8000-000000000004",
      promptSnapshotId: "50000000-0000-4000-8000-000000000005",
      requestedOutputs: { image: true, video: false, narration: true, dialogue: false },
      scenes: [
        {
          sceneId: "scene-1",
          ordinal: 0,
          sceneVersion: 1,
          status: "SUCCEEDED",
          outputs: [
            {
              kind: "IMAGE",
              status: "SUCCEEDED",
              assetId: "60000000-0000-4000-8000-000000000006",
              assetVersion: 1,
              mediaType: "image/png",
              byteSize: 64,
              errorCode: null,
              errorMessage: null,
            },
          ],
        },
      ],
    };
    expect(parsePackage(value, workspaceId).version).toBe(3);
    expect(() => parsePackage({ ...value, workspaceId: scriptId }, workspaceId)).toThrow(
      /another workspace/i,
    );
  });

  it("validates stable persisted discovery pages", () => {
    const item = {
      jobId,
      workspaceId,
      scriptId,
      scriptRevision: 2,
      channelId: null,
      status: "RUNNING",
      version: 1,
      idempotencyKey: "key",
      configSnapshotId: "40000000-0000-4000-8000-000000000004",
      promptSnapshotId: "50000000-0000-4000-8000-000000000005",
      requestedOutputs: { image: true, video: false, narration: false, dialogue: false },
      createdAt: "2026-11-12T00:00:00.000Z",
      updatedAt: "2026-11-12T00:00:01.000Z",
    };
    expect(
      parseSceneJobs({ items: [item], page: 1, pageSize: 25, nextPage: null }, workspaceId).items[0]
        ?.jobId,
    ).toBe(jobId);
    expect(() =>
      parseSceneJobs({ items: [item], page: 0, pageSize: 25, nextPage: null }, workspaceId),
    ).toThrow();
  });

  it("does not present unregistered capability metadata as available", () => {
    expect(() =>
      parseCapabilities(
        {
          workspaceId,
          generatedAt: "2026-11-12T00:00:00.000Z",
          environment: "production",
          capabilities: [
            {
              kind: "IMAGE",
              available: true,
              reason: null,
              message: "Available",
              providerId: null,
              capabilityId: null,
            },
          ],
        },
        workspaceId,
      ),
    ).toThrow(/registration metadata/i);
  });

  it("builds only authenticated API media paths", () => {
    expect(mediaPath(workspaceId, { id: jobId, version: 2 })).toContain(
      `/workspaces/${workspaceId}/assets/${jobId}/versions/2/content`,
    );
    expect(
      artifactPath(workspaceId, jobId, scriptId, true).endsWith(
        `/artifacts/${scriptId}/content?download=true`,
      ),
    ).toBe(true);
  });

  it("rejects negative or unscoped authoritative cost data", () => {
    const value = {
      workspaceId,
      scriptId,
      totals: {
        currencies: [
          {
            currency: "USD",
            totalMinor: -1,
            actualMinor: 0,
            estimatedMinor: 0,
            failedEstimatedMinor: 0,
            reservedMinor: 0,
          },
        ],
        unknownCostRequests: 0,
        unpricedRequests: 0,
        notDispatchedRequests: 0,
      },
      budgets: [],
    };
    expect(() => parseCost(value, workspaceId, scriptId)).toThrow(/currency cost/i);
    expect(() => parseCost({ ...value, workspaceId: jobId }, workspaceId, scriptId)).toThrow();
  });
});
