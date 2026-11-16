import { createHash } from "node:crypto";
import { ShotSpecSchema, type ChannelBrief, type ShotSpec } from "@reelforge/contracts";
import type { Json, Run, Step } from "../runs/runs.types.js";
import { clipEstimate } from "../usage-budget/run-envelope.js";

export interface StepHandler {
  execute(run: Run, brief: ChannelBrief, step: Step): Promise<Json>;
  /** Reconcile a RUNNING step after interruption; null means do not issue another paid call. */
  reconcile(run: Run, brief: ChannelBrief, step: Step): Promise<Json | null>;
}
/** Deterministic V3 fixtures only. V4/V5/V6 replace the registry entries. Never a live adapter. */
class StubStepHandler implements StepHandler {
  public constructor(private readonly key: string) {}
  public async reconcile(): Promise<Json> {
    return this.execute();
  }
  public async execute(): Promise<Json> {
    return { stub: true, step: this.key, verdict: "pass" };
  }
}
export const stepHandlers: Readonly<Record<string, StepHandler>> = Object.fromEntries(
  ["PLANNING", "SCRIPTING", "SHOT_PLANNING", "GENERATING", "ASSEMBLING", "CRITIC"].map((key) => [
    key,
    new StubStepHandler(key),
  ]),
);
export function stubShots(run: Run, brief: ChannelBrief): ShotSpec[] {
  const count = Math.ceil(brief.targetDurationSeconds / 7.5);
  return Array.from({ length: count }, (_, ordinal) =>
    ShotSpecSchema.parse({
      id: stubShotId(run.id, ordinal),
      workspaceId: run.workspaceId,
      schemaVersion: "1.0",
      runId: run.id,
      ordinal,
      version: 1,
      durationSeconds: brief.targetDurationSeconds / count,
      keyframePrompt: "V3 stub keyframe",
      motionPrompt: "V3 stub motion",
      onScreenText: "",
      continuityNotes: [],
      firstFrameFrom: null,
      negativePrompt: "",
      voLine: "",
      dialogue: "",
      camera: "static",
      transition: "cut",
      references: [],
      width: 720,
      height: 1280,
      fps: 24,
      seed: null,
    }),
  );
}
export interface VideoGenPort {
  estimate(shot: ShotSpec, fallback: boolean): number;
  submit(shot: ShotSpec, idempotencyKey: string): Promise<{ providerJobId: string }>;
  reconcile(idempotencyKey: string): Promise<{ providerJobId: string } | null>;
  poll(providerJobId: string): Promise<"queued" | "running" | "succeeded" | "refused" | "failed">;
  fetch(providerJobId: string): Promise<Buffer>;
}
/** Stub jobs and bytes are explicitly labelled and cannot be mistaken for playable media. */
export class StubVideoGenPort implements VideoGenPort {
  public estimate(shot: ShotSpec, fallback: boolean): number {
    return clipEstimate([shot], fallback);
  }
  public async submit(_shot: ShotSpec, key: string): Promise<{ providerJobId: string }> {
    return { providerJobId: `v3-stub-${createHash("sha256").update(key).digest("hex")}` };
  }
  public async reconcile(key: string): Promise<{ providerJobId: string }> {
    return { providerJobId: `v3-stub-${createHash("sha256").update(key).digest("hex")}` };
  }
  public async poll(): Promise<"succeeded"> {
    return "succeeded";
  }
  public async fetch(id: string): Promise<Buffer> {
    return Buffer.from(JSON.stringify({ stub: true, providerJobId: id }));
  }
}

function stubShotId(runId: string, ordinal: number): string {
  const hash = createHash("sha256").update(`${runId}:shot:${ordinal}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
