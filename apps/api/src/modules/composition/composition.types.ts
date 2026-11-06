import { DEFAULT_RENDER_PROFILE } from "@reelforge/media";
export type RenderProfile = typeof DEFAULT_RENDER_PROFILE;
export type RenderSceneInput = Readonly<{
  sceneId: string;
  assetId: string;
  assetVersion: number;
  image: boolean;
  durationMs: number;
  narrationAssetId?: string | undefined;
  narrationAssetVersion?: number | undefined;
  captions: readonly Readonly<{ text: string; startMs: number; endMs: number }>[];
}>;
export type RenderCompositionInput = Readonly<{
  schemaVersion: "1.0";
  title: string;
  profile: RenderProfile;
  sourceMediaPackage: Readonly<{
    jobId: string;
    scriptId: string;
    scriptRevision: number;
    schemaVersion: "1.0";
  }>;
  scenes: readonly RenderSceneInput[];
  audio: readonly Readonly<{ kind: "MUSIC" | "SFX"; assetId: string; assetVersion: number }>[];
  coverFrames: readonly Readonly<{ assetId: string; assetVersion: number; timestampMs: number }>[];
  renderSeed: string;
}>;
export type RenderArtifactView = Readonly<{
  id: string;
  kind: "VIDEO" | "MANIFEST" | "COVER";
  assetId: string;
  assetVersion: number;
  objectKey: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  metadata: Readonly<Record<string, unknown>> | null;
  retainedUntil: string | null;
}>;
export type RenderJobView = Readonly<{
  id: string;
  schemaVersion: "1.0";
  workspaceId: string;
  sceneMediaJobId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "CANCELED";
  attempt: number;
  idempotencyKey: string;
  inputFingerprint: string;
  input: RenderCompositionInput;
  cancelRequestedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retentionDays: number;
  parentJobId: string | null;
  nextRetryAt: string;
  leaseExpiresAt: string | null;
  expiredAt: string | null;
  artifacts: readonly RenderArtifactView[];
}>;

export const COMPOSITION_ENGINE = "COMPOSITION_ENGINE";
