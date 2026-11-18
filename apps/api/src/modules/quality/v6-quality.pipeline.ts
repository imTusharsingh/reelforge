import { ConflictException, Injectable } from "@nestjs/common";
import type { Packaging } from "@reelforge/contracts";
import type { TextPort } from "@reelforge/ai-providers";
import {
  boundedRedo,
  critique,
  multimodalRubric,
  noveltyScore,
  type CriticBrief,
  type CriticClip,
  type NoveltyHistory,
  type ReshootController,
} from "./v6-critic.js";
import { packageShort } from "./v6-packaging.js";

@Injectable()
export class V6QualityPipeline {
  public async review(
    input: Readonly<{
      enabled: boolean;
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
  ): Promise<Readonly<{ criticPassed: boolean; noveltyScore: number; packaging: Packaging }>> {
    if (!input.enabled) throw new ConflictException("pipeline.v2 is disabled");
    const rubric = await multimodalRubric(text, input.critic);
    const result = critique(input.clips, input.brief, rubric);
    await boundedRedo(result, input.redo);
    const novelty = input.novelty ? noveltyScore(input.novelty, input.history ?? []) : 10;
    return {
      criticPassed: result.passed && novelty >= 5,
      noveltyScore: novelty,
      packaging: packageShort(input.package),
    };
  }
}
