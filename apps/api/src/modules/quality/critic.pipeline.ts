import { ConflictException, Injectable } from "@nestjs/common";
import { pipelineV2Enabled } from "@reelforge/config-engine";
import type { Packaging } from "@reelforge/contracts";
import type { TextPort } from "@reelforge/ai-providers";
import { z } from "zod";
import {
  boundedRedo,
  critique,
  multimodalRubric,
  noveltyScore,
  type CriticBrief,
  type CriticClip,
  type CriticResult,
  type NoveltyHistory,
  type ReshootController,
} from "./critic.js";
import { packageShort } from "./short-packaging.js";
import { criticTextPort } from "./critic-text-port.js";

const reviewEvidence = z.object({
  clips: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        probe: z.object({
          durationSeconds: z.number().finite().positive(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          hasBlackFrames: z.boolean(),
          hasFrozenFrames: z.boolean(),
          captionDriftMs: z.number().finite().nullable(),
        }),
        hookText: z.string(),
        narrativeText: z.string(),
        visualDescription: z.string(),
        captionText: z.string(),
      }),
    )
    .min(1),
  critic: z.object({
    prompt: z.string().trim().min(1),
    correlationId: z.string().trim().min(1),
    media: z
      .array(
        z
          .object({
            type: z.literal("video"),
            mime_type: z.string().trim().min(1),
            data: z.string().trim().min(1).optional(),
            uri: z.string().trim().min(1).optional(),
          })
          .refine((item) => Boolean(item.data || item.uri)),
      )
      .min(1),
  }),
});

@Injectable()
export class CriticPipeline {
  public async reviewRun(
    input: Parameters<CriticPipeline["review"]>[0],
    dependencies: Parameters<typeof criticTextPort>[0],
  ): ReturnType<CriticPipeline["review"]> {
    return this.review(input, criticTextPort(dependencies));
  }

  public async review(
    input: Readonly<{
      clips: ReadonlyArray<CriticClip>;
      brief: CriticBrief;
      critic: Readonly<{
        prompt: string;
        media: Parameters<typeof multimodalRubric>[1]["media"];
        correlationId: string;
      }>;
      redo: ReshootController;
      package: Readonly<{
        title: string;
        description: string;
        tags: ReadonlyArray<string>;
        coverFrameTimestampMs: number;
      }>;
      history?: NoveltyHistory;
      novelty?: Readonly<{ title: string; angle: string }>;
    }>,
    text: TextPort,
  ): Promise<
    Readonly<{
      criticPassed: boolean;
      noveltyScore: number;
      packaging: Packaging;
      details: CriticResult;
    }>
  > {
    if (!pipelineV2Enabled()) throw new ConflictException("pipeline.v2 is disabled");
    if (!reviewEvidence.safeParse(input).success)
      throw new ConflictException("V6 review requires measured clips and video evidence");
    const rubric = await multimodalRubric(text, input.critic);
    const result = critique(input.clips, input.brief, rubric);
    await boundedRedo(result, input.redo);
    const novelty = input.novelty ? noveltyScore(input.novelty, input.history ?? []) : 10;
    return {
      criticPassed: result.passed && novelty >= 5,
      noveltyScore: novelty,
      packaging: packageShort(input.package),
      details: result,
    };
  }
}
