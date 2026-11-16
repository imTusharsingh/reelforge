import { Inject, Injectable } from "@nestjs/common";
import { foundationWorkspaceGuard } from "@reelforge/database";
import {
  PlanningRequestSchema,
  type PlanningRequest,
  type PlanningManifest,
  type PlanningScript,
} from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import {
  ScriptwriterService,
  DirectorService,
  type Scriptwriter,
  type Director,
} from "./planning-agents.js";
import { ArtDirectorService, type ArtDirector } from "../character/art-director.service.js";
import { REFERENCE_LIBRARY, type ReferenceLibrary } from "../reference-library/planning.ports.js";
import { pinPlanningShots } from "./planning-shots.js";

/** Callable by V3/V5 step handlers. This service never changes VideoRun state. */
@Injectable()
export class PlanningService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    @Inject(ScriptwriterService) private readonly writer: Scriptwriter,
    @Inject(DirectorService) private readonly director: Director,
    @Inject(ArtDirectorService) private readonly art: ArtDirector,
    @Inject(REFERENCE_LIBRARY) private readonly library: ReferenceLibrary,
  ) {}
  public async plan(
    context: WorkspaceContext,
    value: PlanningRequest,
  ): Promise<{ script: PlanningScript; manifest: PlanningManifest }> {
    const request = PlanningRequestSchema.parse(value);
    if (context.role === "VIEWER" || request.brief.workspaceId !== context.workspaceId)
      throw new Error("Owned Brief and editor permission required");
    const scoped = foundationWorkspaceGuard(this.db, context);
    const run = await scoped.videoRun.findFirst({
      where: {
        id: request.runId,
        channelId: request.brief.channelId,
        channelBriefId: request.brief.id,
        channelBriefVersion: request.brief.version,
      },
    });
    if (!run) throw new Error("Run does not match the pinned Brief");
    const written = await this.writer.write(context, request);
    const directed = await this.director.direct(context, request, written.script);
    const designed = await this.art.design(context, request, directed.shots);
    const shots = await pinPlanningShots(context, request, designed.shots, this.library);
    const voice = request.brief.narratorVoice;
    if (!voice) throw new Error("Channel narrator voice required");
    const manifest: PlanningManifest = {
      schemaVersion: "1.0",
      workspaceId: context.workspaceId,
      runId: request.runId,
      briefId: request.brief.id,
      briefVersion: request.brief.version,
      narratorVoice: voice,
      prompts: [written.prompt, directed.prompt, designed.prompt],
      shots,
    };
    await scoped.shotSpec.createMany({
      data: shots.map((shot) => ({
        id: shot.id,
        workspaceId: context.workspaceId,
        runId: request.runId,
        ordinal: shot.ordinal,
        version: shot.version,
        schemaVersion: shot.schemaVersion,
        document: shot,
      })),
    });
    return { script: written.script, manifest };
  }
}
