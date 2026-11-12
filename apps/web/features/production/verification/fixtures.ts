import type {
  Asset,
  CapabilityCatalog,
  CostBreakdown,
  RenderJob,
  SceneMediaPackage,
  Script,
} from "../model";

export const workspaceId = "10000000-0000-4000-8000-000000000001";
export const scriptId = "20000000-0000-4000-8000-000000000002";
export const jobId = "30000000-0000-4000-8000-000000000003";
export const assetId = "40000000-0000-4000-8000-000000000004";
export const renderId = "50000000-0000-4000-8000-000000000005";
export const artifactId = "60000000-0000-4000-8000-000000000006";

export const script: Script = {
  id: scriptId,
  workspaceId,
  channelId: "70000000-0000-4000-8000-000000000007",
  status: "APPROVED",
  currentRevision: 2,
  revisions: [
    {
      revision: 2,
      document: {
        title: "The twenty-second reset",
        hook: "A small reset can change the next hour.",
        dialogue: "",
        narration: "Pause. Reset. Begin again.",
        cta: "Try it before your next task.",
        metadata: { targetDurationSeconds: 20 },
        scenes: [
          {
            id: "scene-one",
            startSeconds: 0,
            durationSeconds: 8,
            dialogue: "",
            narration: "Put both feet on the floor.",
            visualDescription: "Creator settles into a quiet studio chair.",
            camera: "Slow medium push-in",
            audioCues: ["Room tone"],
          },
          {
            id: "scene-two",
            startSeconds: 8,
            durationSeconds: 12,
            dialogue: "Now choose the next useful thing.",
            narration: "One breath. One decision.",
            visualDescription: "Notebook opens to a clean page.",
            camera: "Overhead cut",
            audioCues: ["Paper movement"],
          },
        ],
      },
    },
  ],
};

export const production: SceneMediaPackage = {
  schemaVersion: "1.0",
  jobId,
  workspaceId,
  scriptId,
  scriptRevision: 2,
  channelId: script.channelId,
  status: "PARTIAL",
  version: 3,
  requestedOutputs: { image: true, video: false, narration: true, dialogue: false },
  scenes: [
    {
      sceneId: "scene-one",
      ordinal: 0,
      sceneVersion: 2,
      status: "SUCCEEDED",
      outputs: [
        {
          kind: "IMAGE",
          status: "SUCCEEDED",
          assetId,
          assetVersion: 1,
          mediaType: "image/png",
          byteSize: 68,
          errorCode: null,
          errorMessage: null,
        },
        {
          kind: "NARRATION",
          status: "FAILED_RETRYABLE",
          assetId: null,
          assetVersion: null,
          mediaType: null,
          byteSize: null,
          errorCode: "PROVIDER_NOT_CONFIGURED",
          errorMessage: "Narration provider is not configured.",
        },
      ],
    },
    {
      sceneId: "scene-two",
      ordinal: 1,
      sceneVersion: 1,
      status: "QUEUED",
      outputs: [],
    },
  ],
};

export const capabilities: CapabilityCatalog = {
  workspaceId,
  generatedAt: "2026-11-12T06:00:00.000Z",
  environment: "production",
  capabilities: (["IMAGE", "VIDEO", "NARRATION", "DIALOGUE"] as const).map((kind) => ({
    kind,
    available: false,
    reason: "PROVIDER_NOT_CONFIGURED",
    message: `${kind.toLowerCase()} generation is not configured.`,
    providerId: null,
    capabilityId: null,
  })),
};

export const asset: Asset = {
  id: assetId,
  workspaceId,
  version: 1,
  rootAssetId: assetId,
  mediaType: "image/png",
  filename: "quiet-studio.png",
  byteSize: 68,
  status: "PUBLISHED",
};

export const costs: CostBreakdown = {
  workspaceId,
  scriptId,
  totals: {
    currencies: [
      {
        currency: "USD",
        totalMinor: 124,
        actualMinor: 84,
        estimatedMinor: 40,
        failedEstimatedMinor: 0,
        reservedMinor: 0,
      },
    ],
    unknownCostRequests: 1,
    unpricedRequests: 0,
    notDispatchedRequests: 1,
  },
  budgets: [],
};

export const render: RenderJob = {
  id: renderId,
  workspaceId,
  sceneMediaJobId: jobId,
  status: "SUCCEEDED",
  attempt: 1,
  idempotencyKey: "render-one",
  input: { schemaVersion: "1.0" },
  retentionDays: 90,
  errorCode: null,
  errorMessage: null,
  expiredAt: null,
  artifacts: [
    {
      id: artifactId,
      kind: "VIDEO",
      assetId,
      assetVersion: 1,
      mediaType: "video/mp4",
      byteSize: 1024,
      retainedUntil: "2027-01-01T00:00:00.000Z",
    },
  ],
};
