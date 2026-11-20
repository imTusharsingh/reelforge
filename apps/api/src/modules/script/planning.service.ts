import { z } from "zod";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { foundationWorkspaceGuard } from "@reelforge/database";
import {
  PlanningRequestSchema,
  PlanningScriptSchema,
  NarratorVoiceSchema,
  ShotSpecSchema,
  type PlanningRequest,
  type PlanningManifest,
  type PlanningScript,
} from "@reelforge/contracts";
import type { Scoped } from "../runs/runs.types.js";
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

import { scopedTransaction } from "../runs/runs.transaction.js";

const receiptKey = "planning:manifest:v1";
const resultSchema = z.object({
  script: PlanningScriptSchema,
  manifest: z.object({
    schemaVersion: z.literal("1.0"),
    workspaceId: z.uuid(),
    runId: z.uuid(),
    briefId: z.uuid(),
    briefVersion: z.int().positive(),
    narratorVoice: NarratorVoiceSchema,
    prompts: z
      .array(
        z.object({
          role: z.enum(["scriptwriter", "director", "art-director"]),
          version: z.literal(2),
          templateVersionId: z.uuid(),
          promptSnapshotId: z.uuid(),
          configSnapshotId: z.uuid(),
          fingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .length(3),
    shots: z.array(ShotSpecSchema).min(1),
  }),
});
type Result = { script: PlanningScript; manifest: PlanningManifest };

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
    // This lock is independent of run revision locks taken by the paid ports.
    // A concurrent retry sees the receipt or returns before any provider work.
    return this.db.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`planning:${run.id}`}, 0)) AS acquired
      `;
        if (!lock?.acquired) throw new ConflictException("Planning is already in progress");
        const guarded = scopedTransaction(tx, context);
        const saved = await guarded.videoRunStep.findFirst({
          where: { runId: run.id, key: receiptKey },
          select: { output: true },
        });
        if (saved) return resultSchema.parse(saved.output);
        const result = await this.generate(context, request);
        await this.persist(guarded, context, request, result);
        return result;
      },
      { timeout: 10 * 60_000 },
    );
  }
  private async generate(context: WorkspaceContext, request: PlanningRequest): Promise<Result> {
    const voice = request.brief.narratorVoice;
    if (!voice) throw new Error("Channel narrator voice required");
    const written = await this.writer.write(context, request);
    const directed = await this.director.direct(context, request, written.script);
    const designed = await this.art.design(context, request, directed.shots);
    const shots = await pinPlanningShots(context, request, designed.shots, this.library);
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
    return resultSchema.parse({ script: written.script, manifest });
  }
  private async persist(
    scoped: Scoped,
    context: WorkspaceContext,
    request: PlanningRequest,
    result: Result,
  ): Promise<void> {
    await scoped.videoRunStep.create({
      data: {
        workspaceId: context.workspaceId,
        runId: request.runId,
        key: receiptKey,
        idempotencyKey: `${request.runId}:${receiptKey}`,
        state: "SUCCEEDED",
        input: {},
        output: result,
        finishedAt: new Date(),
      },
    });
    await scoped.shotSpec.createMany({
      data: result.manifest.shots.map((shot) => ({
        id: shot.id,
        workspaceId: context.workspaceId,
        runId: request.runId,
        ordinal: shot.ordinal,
        version: shot.version,
        schemaVersion: shot.schemaVersion,
        document: shot,
      })),
    });
  }
}
