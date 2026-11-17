export const SCENE_MEDIA_SCHEMA_VERSION = "1.0" as const;

export type SceneMediaKind = "IMAGE" | "VIDEO" | "NARRATION" | "DIALOGUE";

type SceneMediaJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
type SceneGenerationStatus =
  | "QUEUED"
  | "SUBMITTED"
  | "PROVIDER_PROCESSING"
  | "SUCCEEDED"
  | "RETRY_WAIT"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "CANCELED";
type SceneOutputStatus =
  "QUEUED" | "SUCCEEDED" | "REUSED" | "ASSIGNED" | "FAILED_RETRYABLE" | "FAILED_FINAL";

export type RequestedOutputs = Readonly<{
  image: true;
  video: boolean;
  narration: boolean;
  dialogue: boolean;
}>;

type SceneMediaOutput = Readonly<{
  kind: SceneMediaKind;
  status: SceneOutputStatus;
  assetId: string | null;
  assetVersion: number | null;
  mediaType: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  providerJobId: string | null;
  providerAssetId: string | null;
  correlationId: string | null;
  reusedFromOutputId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}>;

type SceneMediaScene = Readonly<{
  sceneId: string;
  ordinal: number;
  sceneVersion: number;
  status: SceneGenerationStatus;
  idempotencyKey: string;
  sourceRefs: unknown;
  outputs: readonly SceneMediaOutput[];
}>;

/** Versioned asset package consumed by M10. Incomplete jobs are not exported. */
export type SceneMediaPackage = Readonly<{
  schemaVersion: typeof SCENE_MEDIA_SCHEMA_VERSION;
  jobId: string;
  workspaceId: string;
  scriptId: string;
  scriptRevision: number;
  channelId: string | null;
  status: SceneMediaJobStatus;
  /** Observed job version. Every accepted mutation increments this token exactly once. */
  version: number;
  idempotencyKey: string;
  configSnapshotId: string;
  promptSnapshotId: string;
  requestedOutputs: RequestedOutputs;
  scenes: readonly SceneMediaScene[];
}>;
