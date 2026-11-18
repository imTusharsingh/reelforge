import { QualityRubricSchema, type QualityRubric } from "@reelforge/contracts";
import type { MediaInput, TextPort } from "@reelforge/ai-providers";

export type ClipProbe = Readonly<{
  durationSeconds: number;
  width: number;
  height: number;
  hasBlackFrames: boolean;
  hasFrozenFrames: boolean;
  captionDriftMs: number;
}>;

export type CriticClip = Readonly<{
  id: string;
  probe: ClipProbe;
  hookText: string;
  narrativeText: string;
  visualDescription: string;
  captionText: string;
}>;

export type CriticBrief = Readonly<{
  requiredTerms: ReadonlyArray<string>;
  bannedTerms: ReadonlyArray<string>;
}>;

export type CriticResult = Readonly<{
  passed: boolean;
  hardGates: ReadonlyArray<
    Readonly<{ clipId: string; passed: boolean; reasons: ReadonlyArray<string> }>
  >;
  rubric: QualityRubric;
  score: number;
  failedAxes: ReadonlyArray<keyof QualityRubric>;
}>;

const axes = ["hook", "coherence", "artifacts", "captionSync", "briefFit", "policy"] as const;

export function v6QualityEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.PIPELINE_V2 === "true";
}

export function critique(
  clips: ReadonlyArray<CriticClip>,
  brief: CriticBrief,
  rubric: QualityRubric,
): CriticResult {
  const hardGates = clips.map((clip) => {
    const reasons: string[] = [];
    if (clip.probe.durationSeconds < 3 || clip.probe.durationSeconds > 10) reasons.push("duration");
    if (clip.probe.width * 16 !== clip.probe.height * 9) reasons.push("aspect");
    if (clip.probe.hasBlackFrames) reasons.push("black frames");
    if (clip.probe.hasFrozenFrames) reasons.push("frozen frames");
    if (Math.abs(clip.probe.captionDriftMs) > 250) reasons.push("caption drift");
    return { clipId: clip.id, passed: reasons.length === 0, reasons };
  });
  const lower = clips
    .map((clip) => `${clip.narrativeText} ${clip.visualDescription}`.toLowerCase())
    .join(" ");
  const briefFit =
    brief.requiredTerms.every((term) => lower.includes(term.toLowerCase())) &&
    !brief.bannedTerms.some((term) => lower.includes(term.toLowerCase()))
      ? rubric.briefFit
      : 0;
  const checked = QualityRubricSchema.parse({ ...rubric, briefFit });
  const failedAxes = axes.filter((axis) => checked[axis] < 5);
  const score = Math.round(axes.reduce((sum, axis) => sum + checked[axis], 0) / axes.length);
  return {
    passed: hardGates.every((gate) => gate.passed) && score >= 7 && failedAxes.length === 0,
    hardGates,
    rubric: checked,
    score,
    failedAxes,
  };
}

export type ReshootController = Readonly<{
  reshoot(clipId: string): Promise<void>;
  reedit(): Promise<void>;
  remainingCents: number;
}>;

export function boundedReshootController(
  delegate: ReshootController,
  hardCapCents = 800,
): ReshootController {
  const attempts = new Map<string, number>();
  let spentCents = 0;
  let reedited = false;
  return {
    get remainingCents(): number {
      return Math.max(0, Math.min(delegate.remainingCents, hardCapCents - spentCents));
    },
    async reshoot(clipId: string): Promise<void> {
      const attempt = (attempts.get(clipId) ?? 0) + 1;
      if (attempt > 2) throw new Error(`Reshoot cap reached for ${clipId}`);
      if (this.remainingCents <= 0) throw new Error("V6 reshoot envelope exhausted");
      attempts.set(clipId, attempt);
      spentCents += 1;
      await delegate.reshoot(clipId);
    },
    async reedit(): Promise<void> {
      if (reedited) throw new Error("V6 re-edit cap reached");
      if (this.remainingCents <= 0) throw new Error("V6 re-edit envelope exhausted");
      reedited = true;
      spentCents += 1;
      await delegate.reedit();
    },
  };
}

export type NoveltyHistory = ReadonlyArray<Readonly<{ title: string; angle: string }>>;

export function noveltyScore(
  candidate: Readonly<{ title: string; angle: string }>,
  history: NoveltyHistory,
): number {
  const words = new Set(
    `${candidate.title} ${candidate.angle}`.toLowerCase().split(/\W+/).filter(Boolean),
  );
  if (words.size === 0 || history.length === 0) return 10;
  const maximumOverlap = Math.max(
    ...history.map((item) => {
      const previous = new Set(
        `${item.title} ${item.angle}`.toLowerCase().split(/\W+/).filter(Boolean),
      );
      return [...words].filter((word) => previous.has(word)).length / words.size;
    }),
  );
  return Math.max(0, Math.round((1 - maximumOverlap) * 10));
}

export async function multimodalRubric(
  text: TextPort,
  input: Readonly<{ prompt: string; media: ReadonlyArray<MediaInput>; correlationId: string }>,
): Promise<QualityRubric> {
  const response = await text.complete(
    {
      prompt: input.prompt,
      media: input.media,
      jsonSchema: {
        type: "object",
        properties: Object.fromEntries(
          axes.map((axis) => [axis, { type: "integer", minimum: 0, maximum: 10 }]),
        ),
        required: [...axes],
        additionalProperties: false,
      },
      parse: (value: unknown) => QualityRubricSchema.parse(value),
    },
    `${input.correlationId}:critic:v6`,
  );
  return QualityRubricSchema.parse(response.output);
}

export async function boundedRedo(
  result: CriticResult,
  controller: ReshootController,
): Promise<void> {
  if (result.passed) return;
  const failed = result.hardGates.filter((gate) => !gate.passed).slice(0, 2);
  for (const gate of failed) {
    if (controller.remainingCents <= 0) return;
    await controller.reshoot(gate.clipId);
  }
  if (failed.length === 0 && controller.remainingCents > 0) await controller.reedit();
}
