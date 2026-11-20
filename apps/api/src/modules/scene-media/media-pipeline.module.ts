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
import { json, type Context, type Run } from "../runs/runs.types.js";
import type { StepHandler } from "../orchestration/video-run.handlers.js";
import { MediaAccess } from "./media-access.js";
import { MediaAccounts } from "./media-accounts.js";
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
    generation.resolvePorts = async (
      context,
      run,
      shot,
    ): ReturnType<NonNullable<RunGeneration["resolvePorts"]>> => {
      await this.accounts.sync(context, run);
      const options = await this.frames.prepare(context, run, shot);
      if (!options) return null;
      const ports = await this.ports.get(context, shot);
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
        );
      return { primary: routed(ports.omni, "gemini"), fallback: routed(ports.grok, "xai") };
    };
    const planning = module.get(RunPlanning, { strict: false });
    planning.handlers = {
      ...planning.handlers,
      PLANNING: this.handler(async (_run, brief) => ({
        idea: brief.topic,
        source: "CHANNEL_BRIEF",
      })),
      SCRIPTING: this.handler(async (run, brief) =>
        json(await this.planning.plan(await this.context(run), run, brief)),
      ),
      SHOT_PLANNING: this.handler(async (run, brief) => {
        const result = await this.planning.saved(await this.context(run), run, brief);
        if (!result) throw new Error("V4 planning result missing");
        return json(result.manifest);
      }),
      ASSEMBLING: this.handler(async (run, brief) =>
        json({
          storageArtifacts: await this.assembly.execute(await this.context(run), run, brief),
        }),
      ),
    };
    // Preserve the V3 writer's public Artifact[] boundary while replacing its fixture implementation.
    module.get(RunOutputs, { strict: false }).assembly = (
      context,
      run,
    ): ReturnType<RunOutputs["assembly"]> => this.assembly.artifacts(context, run);
  }
  private handler(execute: StepHandler["execute"]): StepHandler {
    return { execute, reconcile: execute };
  }
  private async context(run: Run): Promise<Context> {
    const actor = await this.access.runs.store.db.workspaceMembership.findFirst({
      where: {
        workspaceId: run.workspaceId,
        role: { in: ["OWNER", "EDITOR"] },
        workspace: { archivedAt: null },
      },
    });
    if (!actor) throw new Error("Worker actor no longer authorized");
    return { workspaceId: run.workspaceId, userId: actor.userId, role: actor.role };
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
