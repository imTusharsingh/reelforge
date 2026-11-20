import { randomUUID } from "node:crypto";
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

import { withSessionLock } from "../runs/session-lock.js";
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
    return withSessionLock(
      `planning:${run.id}`,
      "run-planning",
      "Planning is already in progress",
      "Planning ownership lost",
      async (assertLocked) => {
        const claim = randomUUID();
        const saved = await this.claim(context, request, claim, assertLocked);
        if (saved) return saved;
        const result = await this.generate(context, request);
        await this.db.$transaction(async (tx) => {
          await assertLocked();
          await this.persist(scopedTransaction(tx, context), request, claim, result);
        });
        return result;
      },
    );
  }

  private async claim(
    context: WorkspaceContext,
    request: PlanningRequest,
    claim: string,
    assertLocked: () => Promise<void>,
  ): Promise<Result | null> {
    return this.db.$transaction(async (tx) => {
      await assertLocked();
      const scoped = scopedTransaction(tx, context);
      const where = { runId: request.runId, key: receiptKey, attempt: 1 };
      const saved = await scoped.videoRunStep.findFirst({ where });
      if (saved?.state === "SUCCEEDED") return resultSchema.parse(saved.output);
      const startedAt = new Date();
      if (saved) {
        await scoped.videoRunStep.updateMany({
          where: { id: saved.id },
          data: { state: "RUNNING", input: { claim }, startedAt },
        });
      } else {
        await scoped.videoRunStep.create({
          data: {
            ...where,
            workspaceId: context.workspaceId,
            idempotencyKey: `${request.runId}:${receiptKey}`,
            state: "RUNNING",
            input: { claim },
            startedAt,
          },
        });
      }
      return null;
    });
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
    request: PlanningRequest,
    claim: string,
    result: Result,
  ): Promise<void> {
    const changed = await scoped.videoRunStep.updateMany({
      where: {
        runId: request.runId,
        key: receiptKey,
        state: "RUNNING",
        input: { equals: { claim } },
      },
      data: { state: "SUCCEEDED", input: {}, output: result, finishedAt: new Date() },
    });
    if (changed.count !== 1) throw new ConflictException("Planning claim changed");
    await scoped.shotSpec.createMany({
      data: result.manifest.shots.map((shot) => ({
        id: shot.id,
        workspaceId: request.brief.workspaceId,
        runId: request.runId,
        ordinal: shot.ordinal,
        version: shot.version,
        schemaVersion: shot.schemaVersion,
        document: shot,
      })),
    });
  }
}
