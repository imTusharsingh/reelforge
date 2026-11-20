import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { reservationCents } from "@reelforge/ai-providers";
import {
  PlanningScriptSchema,
  ShotSpecSchema,
  type ChannelBrief,
  type PlanningManifest,
  type PlanningScript,
} from "@reelforge/contracts";
import type { TextPort, ImageGenPort } from "../reference-library/planning.ports.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { ScriptwriterService, DirectorService } from "../script/planning-agents.js";
import { ArtDirectorService } from "../character/art-director.service.js";
import { PlanningCharacterService } from "../character/planning-character.service.js";
import { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { PlanningService } from "../script/planning.service.js";
import { json, type Context, type Run } from "../runs/runs.types.js";
import { runEstimate } from "../usage-budget/run-envelope.js";
import { MediaAccess } from "./media-access.js";
import { MediaAccounts } from "./media-accounts.js";
import { MediaJobs } from "./media-jobs.js";
import { MediaPorts } from "./media-ports.js";
import { MEDIA_OVERHEAD } from "./media-prices.js";
type PlannedMedia = { script: PlanningScript; manifest: PlanningManifest };
@Injectable()
export class MediaPlanning {
  public constructor(
    private readonly access: MediaAccess,
    private readonly accounts: MediaAccounts,
    private readonly jobs: MediaJobs,
    private readonly ports: MediaPorts,
  ) {}
  public async plan(context: Context, run: Run, brief: ChannelBrief): Promise<PlannedMedia> {
    if (
      !brief.narratorVoice ||
      brief.narratorVoice.providerId !== "gemini" ||
      brief.targetDurationSeconds < 30 ||
      brief.targetDurationSeconds > 45
    )
      throw new Error("V5 requires a narrator and a 30–45 second target");
    const saved = await this.saved(context, run, brief);
    if (saved) return saved;
    const prompts = this.access.modules.get(PlanningPromptService, { strict: false });
    const library = this.access.modules.get(ReferenceLibraryService, { strict: false });
    const text: TextPort = {
      generate: (input): Promise<unknown> => this.text(context, run, input),
    };
    const images = this.imagePort(context, run);
    const art = new ArtDirectorService(
      text,
      images,
      library,
      prompts,
      this.access.modules.get(PlanningReferenceAssetsService, { strict: false }),
      this.access.modules.get(PlanningCharacterService, { strict: false }),
    );
    const service = new PlanningService(
      this.access.runs.store.db,
      new ScriptwriterService(text, prompts),
      new DirectorService(text, prompts),
      art,
      library,
    );
    return service.plan(context, {
      runId: run.id,
      brief,
      idea: brief.topic,
      format: brief.formatKey as "explainer",
    });
  }
  private imagePort(context: Context, run: Run): ImageGenPort {
    return {
      generate: async (input): ReturnType<ImageGenPort["generate"]> => {
        const ports = await this.ports.get(context);
        const references = await this.ports.references(context, {
          references: input.references.map((ref) => ({
            referenceAssetId: ref.referenceId,
            version: ref.version,
          })),
        });
        const key = `reference:${input.idempotencyKey}`;
        const media = await this.jobs.wait(
          context,
          run,
          key,
          ports.image,
          { prompt: input.prompt, references },
          reservationCents({ currency: "USD", microUsd: MEDIA_OVERHEAD.imageMicroUsd }),
          process.env.GEMINI_IMAGE_MODEL ?? "",
          "art-director:v2",
        );
        if (!["image/png", "image/jpeg", "image/webp"].includes(media.receipt.mimeType))
          throw new Error("Expected a reference image");
        return {
          body: await this.jobs.bytes(context, media.receipt),
          mediaType: media.receipt.mimeType as "image/png" | "image/jpeg" | "image/webp",
        };
      },
    };
  }
  public async saved(
    context: Context,
    run: Run,
    brief: ChannelBrief,
  ): Promise<PlannedMedia | null> {
    const db = this.access.runs.store.scoped(context);
    const shots = await db.shotSpec.findMany({
      where: { runId: run.id },
      orderBy: { ordinal: "asc" },
    });
    if (!shots.length) return null;
    const steps = await db.videoRunStep.findMany({
      where: { runId: run.id, key: { startsWith: "media:text:" }, state: "SUCCEEDED" },
    });
    const writer = steps.find((step) => step.key === "media:text:scriptwriter");
    if (!writer || !brief.narratorVoice) throw new Error("Planning receipt or narrator missing");
    const script = PlanningScriptSchema.parse(this.output(writer.output).output);
    const prompts = steps.map(
      (step) => this.output(step.output).promptVersion as PlanningManifest["prompts"][number],
    );
    return {
      script,
      manifest: {
        schemaVersion: "1.0",
        workspaceId: context.workspaceId,
        runId: run.id,
        briefId: brief.id,
        briefVersion: brief.version,
        narratorVoice: brief.narratorVoice,
        prompts,
        shots: shots.map((row) => ShotSpecSchema.parse(row.document)),
      },
    };
  }
  private async text(
    context: Context,
    run: Run,
    input: Parameters<TextPort["generate"]>[0],
  ): Promise<unknown> {
    const db = this.access.runs.store.scoped(context),
      key = `media:text:${input.promptVersion.role}`;
    const previous = await db.videoRunStep.findFirst({ where: { runId: run.id, key } });
    if (previous?.state === "SUCCEEDED") return this.output(previous.output).output;
    if (previous) throw new Error("RECONCILE_REQUIRED: text submission outcome unknown");
    const cost = reservationCents({
      currency: "USD",
      microUsd: Math.ceil(MEDIA_OVERHEAD.textMicroUsd / 3),
    });
    const modelId = process.env.GEMINI_TEXT_MODEL ?? "";
    const native = await this.ports.get(context);
    const step = await this.accounts.begin(
      context,
      run,
      key,
      { prompt: input.prompt, promptVersion: input.promptVersion },
      cost,
      modelId,
    );
    await this.accounts.prepare(context, run, step, modelId);
    const result = await native.text.complete(
      {
        prompt: input.prompt,
        jsonSchema: z.toJSONSchema(input.schema),
        parse: (value): unknown => input.schema.parse(value),
      },
      step.idempotencyKey,
    );
    if (input.promptVersion.role === "director") {
      const shots = z.array(ShotSpecSchema).parse(result.output);
      if (shots.some((shot) => !Number.isInteger(shot.durationSeconds)))
        throw new Error("Omni requires integer-second shots");
      runEstimate(shots);
    }
    const { artifact, receipt } = await this.textReceipt(
      context,
      key,
      input,
      result,
      modelId,
      cost,
    );
    await db.videoRunStep.updateMany({
      where: { id: step.id },
      data: { providerJobId: result.providerJobId },
    });
    await this.accounts.complete(context, step, {
      ...result,
      receipt,
      artifact,
      promptVersion: input.promptVersion,
    });
    return result.output;
  }
  private async textReceipt(
    context: Context,
    key: string,
    input: Parameters<TextPort["generate"]>[0],
    result: { output: unknown; providerJobId: string },
    modelId: string,
    cost: number,
  ): Promise<{
    artifact: import("../runs/runs.types.js").Artifact;
    receipt: import("@reelforge/contracts").MediaReceipt;
  }> {
    const artifact = await this.access.artifacts.put(
      context,
      "refs",
      Buffer.from(JSON.stringify(result.output)),
      "application/json",
    );
    const receipt = {
      key,
      providerId: "gemini",
      providerJobId: result.providerJobId,
      modelId,
      promptVersion: JSON.stringify(input.promptVersion),
      seconds: 0,
      costMinor: cost,
      objectKey: artifact.objectKey,
      checksumSha256: artifact.checksumSha256,
      mimeType: "application/json",
    };
    return { artifact, receipt: { ...receipt, costBasis: "RESERVATION" } };
  }
  private output(value: unknown): Record<string, unknown> {
    const parsed = json(value) as Record<string, unknown>;
    return parsed.result as Record<string, unknown>;
  }
}
