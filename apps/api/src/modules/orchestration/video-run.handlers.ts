import type { ChannelBrief, ShotSpec } from "@reelforge/contracts";
import type { Json, Run, Step, Context } from "../runs/runs.types.js";
export class MissingVideoPricing extends Error {}
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
export interface VideoGenPort {
  readonly providerId: string;
  readonly modelId?: string;
  assertKey?(): void;
  collectionPricing?(shot: ShotSpec): Json;
  estimate(shot: ShotSpec, fallback: boolean): number;
  submit(shot: ShotSpec, idempotencyKey: string): Promise<{ providerJobId: string }>;
  reconcile(idempotencyKey: string): Promise<{ providerJobId: string } | null>;
  poll(providerJobId: string): Promise<"queued" | "running" | "succeeded" | "refused" | "failed">;
  fetch(providerJobId: string, savedOutput: unknown): Promise<Buffer>;
  metadata?(
    id: string,
    shot: ShotSpec,
    savedOutput?: unknown,
  ): {
    seconds: number;
    providerDurationSeconds?: number;
    costMinor: number;
    modelId: string;
    promptVersion: string;
  };
}
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
