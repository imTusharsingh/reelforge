import type { ClipArtifact, FailedJobStatus } from "@reelforge/ai-providers";
import type { ChannelBrief, MediaReceipt, ShotSpec } from "@reelforge/contracts";
import type { Json, Run, Step, Context } from "../runs/runs.types.js";
export class AssemblyInterrupted extends Error {
  public constructor(public readonly delay: number | null) {
    super("Required assembly inputs are pending or failed");
  }
}
export interface StepHandler {
  execute(run: Run, brief: ChannelBrief, step: Step, context: Context): Promise<Json>;
  reconcile(run: Run, brief: ChannelBrief, step: Step, context: Context): Promise<Json | null>;
}
class UnconfiguredStep implements StepHandler {
  public async execute(): Promise<never> {
    throw new Error("VideoRun stage handler is not configured");
  }
  public async reconcile(): Promise<null> {
    return null;
  }
}
/** Registrations are supplied by V4/V5; never fabricate successful production stages. */
export const stepHandlers: Readonly<Record<string, StepHandler>> = Object.fromEntries(
  ["PLANNING", "SCRIPTING", "SHOT_PLANNING", "GENERATING", "ASSEMBLING", "CRITIC"].map((key) => [
    key,
    new UnconfiguredStep(),
  ]),
);
/** Compatibility name for V3's missing-shot boundary. Only V4 may create shot specifications. */
export function stubShots(run: Run, brief: ChannelBrief): ShotSpec[] {
  void run;
  void brief;
  throw new Error("V4 shot list required before generation");
}
export class ShotBillingFailure extends Error {
  public constructor(
    cause: unknown,
    public readonly report?: {
      providerId: string | null;
      jobId: string | null;
      receipt: VideoReceipt;
    },
  ) {
    super("Could not record shot billing", { cause });
  }
  public static rethrow(cause: unknown): never {
    throw new ShotBillingFailure(cause);
  }
}
export class ShotMediaFailure extends Error {
  public constructor(
    public readonly providerId: string,
    public readonly providerJobId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Could not collect shot media", { cause });
  }
}
export class InvalidVideoFormat extends ShotMediaFailure {
  public constructor(providerId: string, providerJobId: string, cause?: Error) {
    super(providerId, providerJobId, cause ?? new Error("Provider returned invalid 720p video"));
  }
}
export interface VideoGenPort {
  readonly providerId: string;
  readonly modelId?: string;
  assertKey?(): void;
  collectionPricing?(shot: ShotSpec): Json;
  estimate(shot: ShotSpec, fallback: boolean): number;
  submit(shot: ShotSpec, idempotencyKey: string): Promise<{ providerJobId: string }>;
  reconcile(idempotencyKey: string): Promise<{ providerJobId: string } | null>;
  poll(
    providerJobId: string,
    billing?: ShotBilling,
  ): Promise<"queued" | "running" | "succeeded" | "refused" | "failed">;
  fetch(providerJobId: string, media?: ClipArtifact, billing?: ShotBilling): Promise<Buffer>;
  collectReceipt?(
    providerJobId: string,
    shot: ShotSpec,
    billing?: ShotBilling,
  ): Promise<VideoReceipt>;
}
export type ShotBilling = {
  savedOutput?: unknown;
  shot: ShotSpec;
  record: (receipt: VideoReceipt, failure?: FailedJobStatus) => Promise<void>;
};
export type VideoReceipt = {
  costBasis: MediaReceipt["costBasis"];
  media: ClipArtifact | null;
  seconds: number;
  providerDurationSeconds: number | null;
  costMinor: number;
  modelId: string;
  promptVersion: string;
};
export type MediaPortResolver = (
  context: Context,
  run: Run,
  shot: ShotSpec,
  admitted?: boolean,
) => Promise<{ primary: VideoGenPort; fallback: VideoGenPort } | null>;
export class UnconfiguredVideoPort implements VideoGenPort {
  public readonly providerId = "unconfigured";
  public estimate(): never {
    throw new Error("Video provider not configured");
  }
  public async submit(): Promise<never> {
    throw new Error("Video provider not configured");
  }
  public async reconcile(): Promise<null> {
    return null;
  }
  public async poll(): Promise<never> {
    throw new Error("Video provider not configured");
  }
  public async fetch(): Promise<never> {
    throw new Error("Video provider not configured");
  }
}
