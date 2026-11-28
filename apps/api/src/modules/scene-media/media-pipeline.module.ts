import { ConfigService } from "../config/config.service.js";
import { PromptService } from "../config/prompt.service.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { PlanningCharacterService } from "../character/planning-character.service.js";
import { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import { Global, Module, Injectable } from "@nestjs/common";
import { ProvidersModule } from "../openai/providers.module.js";
import { AssetModule } from "../asset/asset.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { RunGeneration } from "../orchestration/video-run.generation.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { RunOutputs } from "../orchestration/video-run.outputs.js";
import { json } from "../runs/runs.types.js";
import type { StepHandler } from "../orchestration/video-run.handlers.js";
import { MediaAccess } from "./media-access.js";
import { MediaAccounts } from "./media-accounts.js";
import { recoverTextEvidence } from "../usage-budget/text-attempt-delivery.js";
import { MediaJobs } from "./media-jobs.js";
import { MediaPorts } from "./media-ports.js";
import { MediaFrames } from "./media-frames.js";
import { MediaPlanning } from "./media-planning.js";
import { RoutedMediaVideo } from "./media-video.js";
import { MediaAssembly } from "../composition/media-assembly.js";
import { MediaRenderer } from "../composition/media-render.js";
import { LocalWordAligner } from "../composition/media-alignment.js";
import { SpawnProcessRunner } from "../composition/composition.engine.js";
/** Binding only: V3 retains every transition, SSE, queue and resume decision. */
@Injectable()
export class MediaBindings {
  public constructor(
    private readonly access: MediaAccess,
    private readonly accounts: MediaAccounts,
    private readonly frames: MediaFrames,
    private readonly ports: MediaPorts,
    private readonly jobs: MediaJobs,
    private readonly planning: MediaPlanning,
    private readonly assembly: MediaAssembly,
  ) {}
  public onModuleInit(): void {
    const module = this.access.modules;
    const generation = module.get(RunGeneration, { strict: false });
    generation.resolvePorts = (...args): ReturnType<NonNullable<RunGeneration["resolvePorts"]>> =>
      this.resolveVideoPorts(...args);
    generation.recoverKeyframe = async (context, step): Promise<number | null> =>
      this.jobs.recoverKeyframe(context, step, (await this.ports.get(context)).image);
    const planning = module.get(RunPlanning, { strict: false });
    planning.collectAdmittedReference = async (context, step): Promise<number | null> =>
      this.jobs.collectReference(
        context,
        step,
        (await this.ports.get(context, "collection")).image,
      );
    planning.recoverTextJournal = (context): Promise<void> =>
      recoverTextEvidence(this.access, context);
    planning.collectAdmittedAudio = (context, run): Promise<number | null> =>
      this.assembly.collectAdmittedAudio(context, run);
    planning.handlers = {
      ...planning.handlers,
      PLANNING: this.handler(async (_run, brief) => ({
        idea: brief.topic,
        source: "CHANNEL_BRIEF",
      })),
      SCRIPTING: this.handler(async (run, brief, _step, context) =>
        json(await this.planning.plan(context, run, brief)),
      ),
      SHOT_PLANNING: this.handler(async (run, brief, _step, context) => {
        const result = await this.planning.saved(context, run, brief);
        if (!result) throw new Error("V4 planning result missing");
        return json(result.manifest);
      }),
      ASSEMBLING: this.handler(async (run, brief, _step, context) =>
        json({
          storageArtifacts: await this.assembly.execute(context, run, brief),
        }),
      ),
    };
    // Preserve the V3 writer's public Artifact[] boundary while replacing its fixture implementation.
    module.get(RunOutputs, { strict: false }).assembly = (
      context,
      run,
    ): ReturnType<RunOutputs["assembly"]> => this.assembly.artifacts(context, run);
  }
  private async resolveVideoPorts(
    ...[context, run, shot, admitted]: Parameters<NonNullable<RunGeneration["resolvePorts"]>>
  ): ReturnType<NonNullable<RunGeneration["resolvePorts"]>> {
    if (!admitted) await this.accounts.sync(context, run);
    const options = admitted
      ? this.frames.extension(shot)
      : await this.frames.prepare(context, run, shot);
    if (!options) return null;
    const [ports, videoState] = await Promise.all([
      this.ports.get(context, admitted ? "collection" : shot),
      admitted ? undefined : this.ports.videoState(context.workspaceId),
    ]);
    const routed = (
      port: typeof ports.omni | typeof ports.grok,
      vendor: Parameters<typeof ports.assertKey>[0],
    ): RoutedMediaVideo =>
      new RoutedMediaVideo(
        port,
        this.jobs,
        context,
        run,
        options,
        this.ports.limiter(context.workspaceId, vendor),
        (body, from) => this.frames.extensionTail(body, from),
        () => ports.assertKey(vendor),
        videoState,
        this.ports.videoOutcome(context.workspaceId),
        admitted ? 1 + Number(!!shot.firstFrameFrom) : undefined,
      );
    return { primary: routed(ports.omni, "gemini"), fallback: routed(ports.grok, "xai") };
  }
  private handler(execute: StepHandler["execute"]): StepHandler {
    return { execute, reconcile: execute };
  }
}
@Global()
@Module({
  imports: [ProvidersModule, AssetModule, IdentityModule],
  providers: [
    ConfigService,
    PromptService,
    PlanningPromptService,
    ReferenceLibraryService,
    PlanningCharacterService,
    PlanningReferenceAssetsService,
    MediaAccess,
    MediaAccounts,
    MediaJobs,
    MediaPorts,
    MediaFrames,
    MediaPlanning,
    MediaAssembly,
    MediaRenderer,
    LocalWordAligner,
    SpawnProcessRunner,
    MediaBindings,
  ],
})
export class MediaPipelineModule {}
