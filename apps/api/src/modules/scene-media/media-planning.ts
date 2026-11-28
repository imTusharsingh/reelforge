import type { PaidTextResult } from "../usage-budget/text-attempt-runtime.js";
import {
  InvalidCompletedScript,
  isScriptRepair,
  repairMessage,
  scriptwriterKey,
  validationMessage,
} from "../script/script-repair.js";
import {
  dispatchPlanningText,
  replayPlanningText,
  savedRepairSpec,
  type PlanningTextInput,
} from "./planning-text-dispatch.js";
import { textReceiptReference } from "../usage-budget/text-evidence.js";
import { PLANNING_MANIFEST_KEY } from "../runs/run-outcomes.js";
import { ConflictException, Injectable } from "@nestjs/common";
import { z } from "zod";
import { reservationCents } from "@reelforge/ai-providers";
import {
  StoredPlanningScriptSchema,
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
    const rejected = await this.access.runs.store.scoped(context).videoRunStep.findMany({
      where: { runId: run.id, key: { in: planningKeys }, state: "FAILED" },
    });
    if (rejected.some((step) => !repairMessage(step)))
      throw new Error("Planning provider request was rejected");
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
    const script = StoredPlanningScriptSchema.parse(results[0]!.output);
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
    if (previous?.state === "FAILED") return this.repairScript(context, run, input, previous);
    try {
      return await this.textAttempt(context, run, input, previous);
    } catch (error) {
      if (!(error instanceof InvalidCompletedScript || error instanceof SavedScriptInvalid))
        throw error;
      const failed = await db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key },
        orderBy: { attempt: "desc" },
      });
      if (!repairMessage(failed)) throw error;
      return this.repairScript(context, run, input, failed);
    }
  }

  private async repairScript(
    context: Context,
    run: Run,
    input: PlanningTextInput,
    failed: Step,
  ): Promise<unknown> {
    const reason = repairMessage(failed);
    if (!reason) throw new Error("Planning provider request was rejected");
    const prompt = `${input.prompt}\nThe previous script failed validation: ${reason}. Return a corrected script.`;
    try {
      return await this.textAttempt(context, run, { ...input, prompt }, null, failed.id);
    } catch (error) {
      if (error instanceof ConflictException && error.message === "BUDGET_CAP")
        await this.rejectSavedOutput(context, failed, {
          code: "BUDGET_CAP",
          message: `Script repair admission refused: ${error.message}`,
        });
      throw error;
    }
  }

  private async textAttempt(
    context: Context,
    run: Run,
    input: PlanningTextInput,
    previous: Step | null,
    repairOf?: string,
  ): Promise<unknown> {
    const key = `media:text:${input.promptVersion.role}`;
    if (previous?.state === "SUCCEEDED") {
      const { output, promptVersion } = this.output(previous.output);
      await this.validateAcceptedPlan(context, run, previous, input, output);
      input.onPromptUsed?.(planningPromptReceiptSchema.parse(promptVersion));
      return output;
    }

    const priorRepair =
      previous && this.accounts.abandoned(previous) ? savedRepairSpec(previous) : undefined;
    if (priorRepair) {
      repairOf = priorRepair.repairOf;
      input = { ...input, prompt: priorRepair.prompt, promptVersion: priorRepair.promptVersion };
    }
    const cost = textCallCents();
    const modelId = process.env.GEMINI_TEXT_MODEL?.trim() ?? "";
    const pending =
      previous &&
      !this.accounts.abandoned(previous) &&
      !(await this.accounts.recoverUndispatched(context, previous))
        ? previous
        : null;
    if (!pending && !modelId) throw new ConflictException("Planning text model is not configured");
    const step =
      pending ??
      (await this.accounts.begin(
        context,
        run,
        key,
        { prompt: input.prompt, promptVersion: input.promptVersion, ...(repairOf && { repairOf }) },
        cost,
        modelId,
        true,
      ));
    const result = pending
      ? replayPlanningText(step)
      : await dispatchPlanningText(this.ports, this.accounts, context, step, input);
    await this.validateAcceptedPlan(context, run, step, input, result.output);
    return this.saveTextReceipt(context, step, input, result);
  }

  private async saveTextReceipt(
    context: Context,
    step: Step,
    input: PlanningTextInput,
    result: PaidTextResult,
  ): Promise<unknown> {
    const settled = await this.access.runs.store
      .scoped(context)
      .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    const admitted = textIntent.parse(settled.input);
    const { artifact, receipt } = await this.textReceipt(
      context,
      step.key,
      admitted.spec.promptVersion,
      result,
      admitted.modelId,
      settled,
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
  private async validateAcceptedPlan(
    context: Context,
    run: Run,
    step: Step,
    input: Parameters<TextPort["generate"]>[0],
    output: unknown,
  ): Promise<void> {
    try {
      input.validateOutput?.(input.schema.parse(output));
      this.validatePlan(run, input.promptVersion.role, output);
    } catch (error) {
      // A legacy receipt can be recovered or rejected, but it lacks proof of a journaled completion.
      const writer =
        step.key === scriptwriterKey &&
        !!(await this.access.runs.store.db.textAttemptEvidence.findFirst({
          where: { workspaceId: context.workspaceId, attemptId: step.id, kind: "SUCCEEDED" },
          select: { id: true },
        }));
      const message = validationMessage(error);
      await this.rejectSavedOutput(context, step, {
        code: writer ? "SCRIPT_VALIDATION" : "PROVIDER_INVALID",
        message,
      });
      if (writer) throw new SavedScriptInvalid(message);
      throw error;
    }
  }
  // Legacy receipts have already settled. Preserve their output and ledger entries.
  private async rejectSavedOutput(
    context: Context,
    step: Step,
    error: { code: string; message: string },
  ): Promise<void> {
    const result = await this.access.runs.store.mutate(
      context,
      step.runId,
      "planning_invalid",
      async (db, run) => {
        if (run.state !== "SCRIPTING" || run.pauseReason)
          return { value: null, payload: { stale: true } };
        await db.videoRunStep.updateMany({
          where: { id: step.id, state: { in: ["SUCCEEDED", "WAITING_EXTERNAL"] } },
          data: { state: "FAILED", error, finishedAt: new Date() },
        });
        if (error.code === "SCRIPT_VALIDATION" && !isScriptRepair(step))
          return { value: null, payload: { reason: error.code }, stepId: step.id };
        await db.videoRunStep.updateMany({
          where: {
            runId: run.id,
            key: { in: ["SCRIPTING", PLANNING_MANIFEST_KEY] },
            state: "RUNNING",
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
    result: { output: unknown; providerJobId: string | null },
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

class SavedScriptInvalid extends Error {}
