import { createHash, randomUUID } from "node:crypto";
import { ShotSpecSchema, type ChannelBrief, type ShotSpec } from "@reelforge/contracts";
import type { StepHandler, VideoGenPort } from "../orchestration/video-run.handlers.js";
import type { Run } from "../runs/runs.types.js";
import { reservationCents } from "@reelforge/ai-providers";
import { clipMoney } from "./media-prices.js";
/** Explicit test injection; runtime modules never import this file. */
export class StubVideoGenPort implements VideoGenPort {
  public constructor(public readonly providerId = "gemini") {}
  public estimate(shot: ShotSpec, fallback: boolean): number {
    return reservationCents(clipMoney(shot, fallback));
  }
  public async submit(_shot: ShotSpec, key: string): Promise<{ providerJobId: string }> {
    return { providerJobId: `fixture-${createHash("sha256").update(key).digest("hex")}` };
  }
  public async reconcile(key: string): Promise<{ providerJobId: string }> {
    return { providerJobId: `fixture-${createHash("sha256").update(key).digest("hex")}` };
  }
  public async poll(): Promise<"succeeded"> {
    return "succeeded";
  }
  public async fetch(id: string): Promise<Buffer> {
    return Buffer.from(JSON.stringify({ fixture: true, providerJobId: id }));
  }
}
export function fixtureShots(run: Run, brief: ChannelBrief): ShotSpec[] {
  const count = Math.ceil(brief.targetDurationSeconds / 7.5);
  return Array.from({ length: count }, (_, ordinal) =>
    ShotSpecSchema.parse({
      id: randomUUID(),
      workspaceId: run.workspaceId,
      schemaVersion: "1.0",
      runId: run.id,
      ordinal,
      version: 1,
      durationSeconds: brief.targetDurationSeconds / count,
      keyframePrompt: "fixture keyframe",
      motionPrompt: "fixture motion",
      onScreenText: "",
      continuityNotes: [],
      firstFrameFrom: null,
      negativePrompt: "",
      voLine: "fixture voice",
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
const fixtureCritic = {
  criticPassed: true,
  report: {
    recommendation: "APPROVE",
    summary: "Fixture critic result",
    gates: {
      policy: true,
      rights: true,
      technical: true,
      budget: true,
      permission: true,
      score: true,
    },
  },
};
export const fixtureStageHandlers: Readonly<Record<string, StepHandler>> = Object.fromEntries(
  ["PLANNING", "SCRIPTING", "SHOT_PLANNING", "GENERATING", "ASSEMBLING", "CRITIC"].map((key) => [
    key,
    {
      execute: async () =>
        key === "CRITIC" ? fixtureCritic : { fixture: true, step: key, verdict: "pass" },
      reconcile: async () =>
        key === "CRITIC" ? fixtureCritic : { fixture: true, step: key, verdict: "pass" },
    },
  ]),
);
