import {
  StubVideoGenPort,
  fixtureShots,
  fixtureStageHandlers,
} from "../scene-media/media-provider.fixture.js";
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createDatabaseClient, seedWorkspaceFoundations } from "@reelforge/database";
import { ChannelBriefSchema, type ChannelBrief, type AutonomyLevel } from "@reelforge/contracts";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import { RunsStore } from "./runs.store.js";
import { RunsService } from "./runs.service.js";
import { RunsArtifacts } from "./runs.artifacts.js";
import { RunsBoundary } from "./runs.boundary.js";
import { RunsControl } from "./runs.control.js";
import { RunsQueue } from "./runs.queue.js";
import { RunsEvents } from "./runs.events.js";
import { RunGeneration } from "../orchestration/video-run.generation.js";
import { RunFallback } from "../orchestration/video-run.fallback.js";
import { RunPlanning } from "../orchestration/video-run.planning.js";
import { RunOutputs } from "../orchestration/video-run.outputs.js";
import { VideoRunEngine } from "../orchestration/video-run.engine.js";
import type { Context, Run, Step } from "./runs.types.js";

export function runsFixture(maxConnections?: number): {
  tenant: (
    autonomy?: AutonomyLevel,
    seconds?: number,
    narrator?: ChannelBrief["narratorVoice"],
    seedShots?: boolean,
  ) => Promise<Tenant>;
} {
  const db = createDatabaseClient(
    process.env.DATABASE_URL ?? "postgresql://unused",
    maxConnections,
  );
  const ids: string[] = [],
    users: string[] = [],
    roots: string[] = [];
  const transports: Array<RunsQueue | RunsEvents> = [];
  afterAll(async () => {
    await Promise.all(transports.map((t) => t.close()));
    await db.workspace.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
    await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
  });
  return {
    tenant: async (
      autonomy = "L2",
      seconds = 45,
      narrator: ChannelBrief["narratorVoice"] = null,
      seedShots = true,
    ): Promise<Tenant> => {
      const workspaceId = randomUUID(),
        userId = randomUUID(),
        channelId = randomUUID(),
        briefId = randomUUID();
      ids.push(workspaceId);
      users.push(userId);
      await db.user.create({ data: { id: userId, email: `${userId}@v3.invalid` } });
      await db.workspace.create({ data: { id: workspaceId, name: "V3 fixture" } });
      await db.workspaceMembership.create({ data: { workspaceId, userId, role: "OWNER" } });
      await db.channel.create({ data: { id: channelId, workspaceId, name: "V3 channel" } });
      await seedWorkspaceFoundations(db, workspaceId);
      const brief = ChannelBriefSchema.parse({
        id: briefId,
        workspaceId,
        channelId,
        schemaVersion: "1.0",
        version: 1,
        topic: "Trees",
        niche: "science",
        audience: "Everyone",
        styleBible: {
          visualStyle: "watercolor",
          palette: [],
          recurringCharacters: [],
          bannedVisuals: [],
        },
        guardrails: {
          bannedTopics: [],
          topicsToAvoid: [],
          blockedPersonaAdvice: ["health", "legal", "finance", "political"],
          allowRealPeople: false,
          allowBrands: false,
          factCheckStrictness: "STRICT",
          aiDisclosure: true,
        },
        formatMix: [{ formatKey: "explainer", weight: 1 }],
        tuningBounds: null,
        languages: { script: "English", narration: "English", captions: "English" },
        onCameraVoice: null,
        formatKey: "explainer",
        targetDurationSeconds: seconds,
        narrationLanguage: "English",
        narratorVoice: narrator,
        requestedAutonomy: autonomy,
        cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
        aiDisclosure: true,
        renderProfile: { id: "vertical", width: 1080, height: 1920, fps: 24, videoCodec: "h264" },
        budgetPolicy: {
          currency: "USD",
          targetMinor: 600,
          hardCapMinor: 800,
          dailyLimitMinor: 2000,
          monthlyLimitMinor: 18000,
        },
        references: [],
        referenceDefaults: null,
        constraints: {},
      });
      await db.channelBrief.create({
        data: { id: briefId, workspaceId, channelId, version: 1, document: brief },
      });
      const context: Context = { workspaceId, userId, role: "OWNER" };
      const root = await mkdtemp(join(tmpdir(), "v3-storage-"));
      roots.push(root);
      const store = new RunsStore(db),
        storage = new LocalFilesystemStorageAdapter(root);
      const artifacts = new RunsArtifacts(storage, store),
        runs = new RunsService(store, artifacts);
      const stop = { stopped: false, scope: null, reason: null };
      const boundary = new RunsBoundary({ check: async (): Promise<typeof stop> => stop }, runs);
      const usage = new UsageBudgetService(db, () => new Date());
      const paid = new RunPaidCalls(usage, store),
        fallback = new RunFallback(runs, paid);
      const generation = new RunGeneration(runs, boundary, paid, artifacts, fallback);
      generation.provider = new StubVideoGenPort();
      generation.fallbackProvider = new StubVideoGenPort("xai");
      const outputs = new RunOutputs(artifacts, store);
      const planning = new RunPlanning(runs, outputs);
      planning.handlers = fixtureStageHandlers;
      const engine = new VideoRunEngine(runs, boundary, generation, planning, artifacts);
      const control = new RunsControl(runs, boundary);
      const run = await runs.create(context, briefId, randomUUID());
      if (seedShots)
        await db.shotSpec.createMany({
          data: fixtureShots(run, brief).map((shot) => ({
            id: shot.id,
            workspaceId,
            runId: run.id,
            ordinal: shot.ordinal,
            version: shot.version,
            document: shot,
          })),
        });
      return {
        db,
        context,
        run,
        brief,
        store,
        storage,
        artifacts,
        runs,
        generation,
        usage,
        planning,
        outputs,
        engine,
        control,
        stop,
        connect: (): void => {
          if (!process.env.REDIS_URL) throw new Error("Redis required");
          const queue = new RunsQueue(process.env.REDIS_URL),
            events = new RunsEvents(store, process.env.REDIS_URL);
          runs.queue = queue;
          runs.events = events;
          transports.push(queue, events);
        },
      };
    },
  };
}
export type Tenant = {
  db: ReturnType<typeof createDatabaseClient>;
  context: Context;
  run: Run;
  brief: ReturnType<typeof ChannelBriefSchema.parse>;
  store: RunsStore;
  storage: LocalFilesystemStorageAdapter;
  artifacts: RunsArtifacts;
  runs: RunsService;
  generation: RunGeneration;
  usage: UsageBudgetService;
  planning: RunPlanning;
  outputs: RunOutputs;
  engine: VideoRunEngine;
  control: RunsControl;
  stop: { stopped: boolean; scope: null; reason: null };
  connect: () => void;
};
export async function downgradeToLegacyAdmission(t: Tenant, run: Run, shot: Step): Promise<void> {
  const where = { workspaceId: run.workspaceId, correlationId: shot.id };
  await t.db.$transaction([
    t.db.videoRunStep.update({ where: { id: shot.id }, data: { costMinor: 70 } }),
    t.db.usageReservation.updateMany({ where, data: { amountMinor: 70n } }),
    t.db.providerRequest.updateMany({ where, data: { estimatedCost: 0.7 } }),
    t.db.budgetEnvelope.updateMany({ where: { runId: run.id }, data: { reservedMinor: 70 } }),
  ]);
}
export async function generating(t: Tenant): Promise<Run> {
  for (let i = 0; i < 3; i++) await t.engine.process(t.runs.job(t.context, t.run.id));
  return t.store.get(t.context, t.run.id);
}
export async function generateClips(t: Tenant): Promise<Run> {
  const steps = await t.store.scoped(t.context).videoRunStep.findMany({
    where: { runId: t.run.id, key: { startsWith: "shot-" }, state: "PENDING" },
  });
  for (const step of steps) await t.engine.process(t.runs.job(t.context, t.run.id, step.id));
  return t.store.get(t.context, t.run.id);
}
