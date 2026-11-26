import { validatePlanningShots } from "../script/planning-validation.js";
import { PlanningCharacterService } from "./planning-character.service.js";
import { screenPlanningContent, validatePlanningAccess } from "../script/planning-guardrails.js";
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ArtPlanSchema,
  type ArtPlan,
  PlanningRequestSchema,
  type PlanningRequest,
  type ShotSpec,
  type ReferenceAsset,
  type PlanningPromptReceipt,
} from "@reelforge/contracts";
import {
  PLANNING_TEXT,
  PLANNING_IMAGES,
  REFERENCE_LIBRARY,
  type TextPort,
  type ImageGenPort,
  type ReferenceLibrary,
} from "../reference-library/planning.ports.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { planningModels } from "../config/planning-prompts.js";
import { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import type { WorkspaceContext } from "../identity/identity.types.js";
import {
  selectReferences,
  referencePins,
  planningReferencePins,
} from "../reference-library/reference-selection.js";

export interface ArtDirector {
  design(
    context: WorkspaceContext,
    request: PlanningRequest,
    shots: readonly ShotSpec[],
  ): Promise<{
    references: ReferenceAsset[];
    shots: ShotSpec[];
    voiceId: string;
    prompt: PlanningPromptReceipt;
  }>;
}
@Injectable()
export class ArtDirectorService implements ArtDirector {
  public constructor(
    @Inject(PLANNING_TEXT) private readonly text: TextPort,
    @Inject(PLANNING_IMAGES) private readonly images: ImageGenPort,
    @Inject(REFERENCE_LIBRARY) private readonly library: ReferenceLibrary,
    private readonly prompts: PlanningPromptService,
    private readonly assets: PlanningReferenceAssetsService,
    private readonly characters: PlanningCharacterService,
  ) {}
  public async design(
    context: WorkspaceContext,
    value: PlanningRequest,
    valueShots: readonly ShotSpec[],
  ): Promise<{
    references: ReferenceAsset[];
    shots: ShotSpec[];
    voiceId: string;
    prompt: PlanningPromptReceipt;
  }> {
    const request = PlanningRequestSchema.parse(value);
    const shots = validatePlanningShots(valueShots, request);
    validatePlanningAccess(context, request);
    if (
      shots.some((shot) => shot.workspaceId !== context.workspaceId || shot.runId !== request.runId)
    )
      throw new Error("Foreign shot");
    const voice = request.brief.narratorVoice;
    if (!voice) throw new Error("Channel narrator voice required");
    const prompt = await this.prompts.capture(context, request.brief.channelId, "art-director");
    let usedPrompt = prompt.receipt;
    const validate = (value: unknown): ArtPlan => {
      const plan = ArtPlanSchema.parse(value);
      if (plan.keyframePrompts.length !== shots.length)
        throw new Error("One keyframe prompt per shot required");
      screenPlanningContent(request, JSON.stringify(plan));
      return plan;
    };
    const plan = validate(
      await this.text.generate({
        workspaceId: context.workspaceId,
        runId: request.runId,
        idempotencyKey: `${request.runId}:art-director`,
        modelId: planningModels.text,
        schema: ArtPlanSchema,
        validateOutput: validate,
        promptVersion: prompt.receipt,
        onPromptUsed: (receipt) => {
          usedPrompt = receipt;
        },
        prompt: `${prompt.prompt}\n${JSON.stringify({ request, shots })}`,
      }),
    );
    let references = await this.resolveOrGenerate(context, request, plan);
    references = selectReferences(references);
    return {
      references,
      voiceId: voice.voiceId,
      prompt: usedPrompt,
      shots: shots.map((shot, ordinal) => ({
        ...shot,
        keyframePrompt: plan.keyframePrompts[ordinal]!,
        motionPrompt: `${shot.motionPrompt}. Single continuous shot. No dialogue or on-screen speech; all speech is TTS.`,
        references: referencePins(references),
      })),
    };
  }
  private async resolveOrGenerate(
    context: WorkspaceContext,
    request: PlanningRequest,
    plan: ArtPlan,
  ): Promise<ReferenceAsset[]> {
    const channelId = request.brief.channelId;
    const defaults = await this.library.defaults(context, channelId);
    const pins = planningReferencePins(defaults, request.brief);
    if (pins.length) return this.library.resolve(context, pins);

    return this.library.withInitializationLock(context, channelId, async (assertLocked) => {
      const observed = await this.library.defaults(context, channelId);
      const currentPins = planningReferencePins(observed, request.brief);
      if (currentPins.length) return this.library.resolve(context, currentPins);

      const references = await this.generateReferences(context, request, plan, assertLocked);
      await assertLocked();
      const initialized = await this.library.initializeDefaults(
        context,
        {
          id: randomUUID(),
          schemaVersion: "1.0",
          workspaceId: context.workspaceId,
          channelId,
          character: referencePins(references.filter((ref) => ref.kind === "CHARACTER")),
          style: referencePins(references.filter((ref) => ref.kind === "STYLE")),
          scenery: [],
          prop: [],
        },
        observed,
      );
      if (initialized) return references;

      const latest = await this.library.defaults(context, channelId);
      const latestPins = planningReferencePins(latest, request.brief);
      if (!latestPins.length)
        throw new Error("Channel reference defaults changed during initialization");
      return this.library.resolve(context, latestPins);
    });
  }
  private async generateReferences(
    context: WorkspaceContext,
    request: PlanningRequest,
    plan: ArtPlan,
    assertLocked: () => Promise<void>,
  ): Promise<ReferenceAsset[]> {
    const references: ReferenceAsset[] = [];
    if (plan.character) {
      for (const [view, description] of Object.entries(plan.character)) {
        await assertLocked();
        references.push(
          await this.generate(
            context,
            request,
            "CHARACTER",
            `${view}: ${description}`,
            references,
            assertLocked,
          ),
        );
      }
    }
    await assertLocked();
    references.push(
      await this.generate(context, request, "STYLE", plan.styleFrame, references, assertLocked),
    );
    const characterRefs = references.filter((ref) => ref.kind === "CHARACTER");
    if (characterRefs.length) {
      const characterVersionId = await this.characters.publish(
        context,
        characterRefs,
        request.brief.narratorVoice!.voiceId,
        request.brief.styleBible.visualStyle,
      );
      for (const reference of characterRefs) reference.characterVersionId = characterVersionId;
    }
    for (const reference of references) await this.library.save(context, reference);
    return references;
  }
  private async generate(
    context: WorkspaceContext,
    request: PlanningRequest,
    kind: "CHARACTER" | "STYLE",
    prompt: string,
    references: ReferenceAsset[],
    assertLocked: () => Promise<void>,
  ): Promise<ReferenceAsset> {
    screenPlanningContent(request, prompt);
    const image = await this.images.generate({
      workspaceId: context.workspaceId,
      runId: request.runId,
      idempotencyKey: `${request.brief.channelId}:${kind}:${references.length}`,
      modelId: planningModels.image,
      prompt,
      references,
      assertLocked,
    });
    const asset = await this.assets.store(context, image);
    const reference: ReferenceAsset = {
      id: randomUUID(),
      referenceId: randomUUID(),
      schemaVersion: "1.0",
      workspaceId: context.workspaceId,
      version: 1,
      kind,
      source: "SYSTEM",
      name: kind,
      assetId: asset.assetId,
      assetVersion: asset.version,
      characterVersionId: null,
      checksumSha256: asset.checksumSha256,
      rights: {
        license: "SYSTEM_GENERATED",
        rightsHolder: context.workspaceId,
        attestedAt: new Date().toISOString(),
      },
      metadata: {
        voiceId: request.brief.narratorVoice!.voiceId,
        styleNotes: request.brief.styleBible.visualStyle,
      },
      createdAt: new Date().toISOString(),
    };
    return reference;
  }
}
