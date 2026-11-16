import { randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { createDatabaseClient } from "./client.js";
import { foundationWorkspaceGuard } from "./foundation-workspace.js";
export function foundationFixture(): {
  db: ReturnType<typeof createDatabaseClient>;
  own: string;
  foreign: string;
  userId: string;
  channelId: string;
  briefId: string;
  runId: string;
  ids: Record<string, string>;
  scoped: ReturnType<typeof foundationWorkspaceGuard>;
} {
  const db = createDatabaseClient(process.env.DATABASE_URL ?? "postgresql://unused");
  const own = randomUUID(),
    foreign = randomUUID(),
    userId = randomUUID();
  const channelId = randomUUID(),
    briefId = randomUUID(),
    runId = randomUUID();
  const ids: Record<string, string> = {};
  const scoped = foundationWorkspaceGuard(db, { workspaceId: own, userId, role: "OWNER" });
  async function insertGroup0(): Promise<void> {
    ids.workspaceFoundationDefaults = (
      await db.workspaceFoundationDefaults.create({ data: { workspaceId: foreign, settings: {} } })
    ).id;
    ids.formatTemplate = (
      await db.formatTemplate.create({
        data: { workspaceId: foreign, key: "explainer", name: "Explainer", structure: {} },
      })
    ).id;
    ids.channelBrief = (
      await db.channelBrief.create({
        data: { id: briefId, workspaceId: foreign, channelId, version: 1, document: {} },
      })
    ).id;
    ids.videoRun = (
      await db.videoRun.create({
        data: {
          id: runId,
          workspaceId: foreign,
          channelId,
          channelBriefId: briefId,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          inputSnapshot: {},
        },
      })
    ).id;
  }
  async function insertGroup1(): Promise<void> {
    ids.videoRunStep = (
      await db.videoRunStep.create({
        data: {
          workspaceId: foreign,
          runId,
          key: "script",
          idempotencyKey: randomUUID(),
          input: {},
        },
      })
    ).id;
    ids.shotSpec = (
      await db.shotSpec.create({ data: { workspaceId: foreign, runId, ordinal: 0, document: {} } })
    ).id;
    ids.providerCapability = (
      await db.providerCapability.create({
        data: {
          workspaceId: foreign,
          providerId: "fixture",
          modelId: "fixture",
          kind: "VIDEO",
          document: {},
        },
      })
    ).id;
  }
  async function insertGroup2(): Promise<void> {
    ids.runEvent = (
      await db.runEvent.create({
        data: {
          workspaceId: foreign,
          runId,
          sequence: 1,
          type: "created",
          correlationId: randomUUID(),
          payload: {},
        },
      })
    ).id;
    ids.budgetEnvelope = (
      await db.budgetEnvelope.create({ data: { workspaceId: foreign, runId } })
    ).id;
    ids.referenceAsset = (
      await db.referenceAsset.create({
        data: {
          workspaceId: foreign,
          referenceId: randomUUID(),
          kind: "SCENERY",
          source: "UPLOADED",
          checksumSha256: "a".repeat(64),
          document: {},
        },
      })
    ).id;
    ids.channelReferenceDefaults = (
      await db.channelReferenceDefaults.create({
        data: { workspaceId: foreign, channelId, document: {} },
      })
    ).id;
  }
  beforeAll(async () => {
    await db.workspace.createMany({
      data: [
        { id: own, name: "own" },
        { id: foreign, name: "foreign" },
      ],
    });
    await db.channel.create({ data: { id: channelId, workspaceId: foreign, name: "Foreign" } });
    await insertGroup0();
    await insertGroup1();
    await insertGroup2();
  });
  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: { in: [own, foreign] } } });
    await db.$disconnect();
  });
  return { db, own, foreign, userId, channelId, briefId, runId, ids, scoped };
}
