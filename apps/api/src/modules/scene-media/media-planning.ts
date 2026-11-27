import { textReceiptReference } from "../usage-budget/text-evidence.js";
import { PLANNING_MANIFEST_KEY } from "../runs/run-outcomes.js";
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
import { planningPromptReceiptSchema, PlanningService } from "../script/planning.service.js";
import { type Context, type Run, type Step } from "../runs/runs.types.js";
import { pinnedBudget, runEstimate } from "../usage-budget/run-envelope.js";
import { MediaAccess } from "./media-access.js";
import { MediaAccounts } from "./media-accounts.js";
import { MediaJobs } from "./media-jobs.js";
import { MediaPorts } from "./media-ports.js";
import { MEDIA_OVERHEAD, textCallCents } from "./media-prices.js";
const textIntent = z.object({
  modelId: z.string().min(1),
  spec: z.object({ promptVersion: planningPromptReceiptSchema }),
});
const roles = ["scriptwriter", "director", "art-director"] as const;
const planningKeys = roles.map((role) => `media:text:${role}`);
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
    const rejected = await this.access.runs.store.scoped(context).videoRunStep.findFirst({
      where: { runId: run.id, key: { in: planningKeys }, state: "FAILED" },
    });
    if (rejected) throw new Error("Planning provider request was rejected");
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
          0,
          input.assertLocked,
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
      where: { runId: run.id, key: { in: planningKeys }, state: "SUCCEEDED" },
    });
    if (!brief.narratorVoice) throw new Error("Planning narrator missing");
    const results = roles.map((role) => {
      const matches = steps.filter((step) => step.key === `media:text:${role}`);
      if (matches.length !== 1) throw new Error(`Expected one ${role} planning receipt`);
      const result = this.output(matches[0]!.output);
      const prompt = planningPromptReceiptSchema.parse(result.promptVersion);
      if (prompt.role !== role) throw new Error("Planning receipt role mismatch");
      return { prompt, output: result.output };
    });
    const script = PlanningScriptSchema.parse(results[0]!.output);
    const prompts = results.map((result) => result.prompt);
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
    const previous = await db.videoRunStep.findFirst({
      where: { runId: run.id, key },
      orderBy: { attempt: "desc" },
    });
    if (previous?.state === "SUCCEEDED") {
      const { output, promptVersion } = this.output(previous.output);
      await this.validateAcceptedPlan(context, run, previous, input, output);
      input.onPromptUsed?.(planningPromptReceiptSchema.parse(promptVersion));
      return output;
    }
    if (previous?.state === "FAILED") throw new Error("Planning provider request was rejected");
    const cost = textCallCents();
    const modelId = process.env.GEMINI_TEXT_MODEL ?? "";
    const pending =
      previous &&
      !this.accounts.abandoned(previous) &&
      !(await this.accounts.recoverUndispatched(context, previous))
        ? previous
        : null;
    const step =
      pending ??
      (await this.accounts.begin(
        context,
        run,
        key,
        { prompt: input.prompt, promptVersion: input.promptVersion },
        cost,
        modelId,
      ));
    const result = await this.textResult(context, run, step, input, modelId, !!pending);
    await this.validateAcceptedPlan(context, run, step, input, result.output);
    const admitted = textIntent.parse(step.input);
    const { artifact, receipt } = await this.textReceipt(
      context,
      key,
      admitted.spec.promptVersion,
      result,
      admitted.modelId,
      step,
    );
    await this.accounts.complete(context, step, {
      ...result,
      receipt,
      artifact,
      promptVersion: admitted.spec.promptVersion,
    });
    input.onPromptUsed?.(admitted.spec.promptVersion);
    return result.output;
  }
  private async textResult(
    context: Context,
    run: Run,
    step: Step,
    input: Parameters<TextPort["generate"]>[0],
    modelId: string,
    replay: boolean,
  ): Promise<{ output: unknown; providerJobId: string; usage: Record<string, unknown> }> {
    if (replay) {
      const saved = z
        .object({
          output: input.schema,
          providerJobId: z.string().min(1),
          usage: z.record(z.string(), z.unknown()),
        })
        .safeParse(step.output);
      if (
        !saved.success ||
        (saved.data.providerJobId !== step.providerJobId &&
          saved.data.providerJobId !== step.idempotencyKey)
      )
        throw new Error(`RECONCILE_REQUIRED: text submission outcome unknown (${step.id})`);
      return saved.data;
    }
    const native = await this.ports.get(context);
    await this.accounts.prepare(context, run, step, modelId);
    return this.accounts.dispatchText(context, step, () =>
      native.text.complete(
        {
          prompt: input.prompt,
          jsonSchema: z.toJSONSchema(input.schema),
          parse: (value): unknown => input.schema.parse(value),
        },
        step.idempotencyKey,
      ),
    );
  }

  private async validateAcceptedPlan(
    context: Context,
    run: Run,
    step: Step,
    input: Parameters<TextPort["generate"]>[0],
    output: unknown,
  ): Promise<void> {
    try {
      input.validateOutput?.(output);
      this.validatePlan(run, input.promptVersion.role, output);
    } catch (error) {
      if (step.state === "SUCCEEDED") {
        await this.rejectSavedOutput(context, step);
        throw error;
      }
      const accepted = await this.access.runs.store
        .scoped(context)
        .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
      const event = await this.access.paid.finalizeJobFailure(
        context,
        accepted,
        "PROVIDER_INVALID",
      );
      await this.access.runs.events?.publish(event);
      throw error;
    }
  }
  // Legacy receipts have already settled. Preserve their output and ledger entries.
  private async rejectSavedOutput(context: Context, step: Step): Promise<void> {
    const result = await this.access.runs.store.mutate(
      context,
      step.runId,
      "planning_invalid",
      async (db, run) => {
        if (run.state !== "SCRIPTING") return { value: null, payload: { stale: true } };
        const error = {
          code: "PROVIDER_INVALID",
          message: "Saved planning output failed validation",
        };
        await db.videoRunStep.updateMany({
          where: {
            runId: run.id,
            OR: [
              { id: step.id, state: "SUCCEEDED" },
              { key: { in: ["SCRIPTING", PLANNING_MANIFEST_KEY] }, state: "RUNNING" },
            ],
          },
          data: { state: "FAILED", error, finishedAt: new Date() },
        });
        await db.videoRun.updateMany({
          where: { id: run.id },
          data: {
            state: "FAILED",
            pauseReason: error.code,
            ...(run.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
          },
        });
        return { value: null, payload: { reason: error.code }, stepId: step.id };
      },
    );
    await this.access.runs.events?.publish(result.event);
  }
  private validatePlan(run: Run, role: string, output: unknown): void {
    if (role === "director") {
      const shots = z.array(ShotSpecSchema).parse(output);
      if (shots.some((shot) => !Number.isInteger(shot.durationSeconds)))
        throw new Error("Omni requires integer-second shots");
      runEstimate(shots, false, pinnedBudget(run).hardCapMinor);
    }
  }
  private async textReceipt(
    context: Context,
    key: string,
    promptVersion: z.infer<typeof planningPromptReceiptSchema>,
    result: { output: unknown; providerJobId: string },
    modelId: string,
    step: Step,
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
      ...textReceiptReference(step, result.providerJobId),
      modelId,
      promptVersion: JSON.stringify(promptVersion),
      seconds: 0,
      costMinor: step.costMinor ?? 0,
      objectKey: artifact.objectKey,
      checksumSha256: artifact.checksumSha256,
      mimeType: "application/json",
    };
    return { artifact, receipt: { ...receipt, costBasis: "RESERVATION" } };
  }
  private output(value: unknown): Record<string, unknown> {
    return z.object({ result: z.record(z.string(), z.unknown()) }).parse(value).result;
  }
}
