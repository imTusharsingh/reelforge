import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { ProviderRegistry } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ScriptService } from "./script.service.js";
import type { ScriptLlmPort } from "./script.types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const ownerId = randomUUID();
const workspaceId = randomUUID();
const channelId = randomUUID();
const genreId = randomUUID();
const ideaId = randomUUID();
const snapshotId = randomUUID();
const budgetId = randomUUID();
const context: WorkspaceContext = { workspaceId, userId: ownerId, role: "OWNER" };
const document = {
  schemaVersion: "1.0" as const,
  title: "T",
  hook: "H",
  dialogue: "D",
  cta: "C",
  metadata: { genre: "Integration genre", targetDurationSeconds: 1, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 1,
      characterRefs: [],
      dialogue: "D",
      visualDescription: "V",
      camera: "wide",
      audioCues: [],
    },
  ],
};
const llm: ScriptLlmPort = {
  capability: {
    providerId: "fixture",
    capabilityId: "llm",
    kind: "llm",
    input: ["text"],
    output: ["json"],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: 1 },
  },
  complete: async () => ({
    output: document,
    metadata: {
      modelVersion: "fixture-model",
      promptVersion: "fixture-prompt",
      cost: 1,
      currency: "USD",
    },
  }),
};

suite("ScriptService persisted tenant, lifecycle, and budget behavior", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const service = new ScriptService(
    db as Database,
    llm,
    ((): ProviderRegistry => {
      const registry = new ProviderRegistry();
      registry.register({
        capability: llm.capability,
        credential: { providerId: "fixture", environment: "test", secret: "fixture-secret" },
      });
      return registry;
    })(),
  );

  beforeAll(async (): Promise<void> => {
    if (!db) return;
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@script.integration.invalid` } });
    await db.workspace.create({ data: { id: workspaceId, name: "script-integration" } });
    await db.workspaceMembership.create({ data: { workspaceId, userId: ownerId, role: "OWNER" } });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "integration" } });
    await db.genre.create({
      data: {
        id: genreId,
        workspaceId,
        name: "Integration genre",
        audience: "all",
        tone: "plain",
        topicsAllowed: [],
        topicsBlocked: [],
        language: "en",
        structure: {},
        durationPreference: {},
        safetyProfile: {},
      },
    });
    await db.idea.create({
      data: {
        id: ideaId,
        workspaceId,
        channelId,
        origin: "USER",
        status: "APPROVED",
        title: "Approved",
        normalizedTitle: "approved",
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        approvedAt: new Date(),
        createdByUserId: ownerId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        ideaId,
        channelId,
        topic: "topic",
        hook: "hook",
        angle: "angle",
        audience: "all",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        checksumSha256: "checksum",
      },
    });
    await db.providerBudget.create({
      data: { id: budgetId, workspaceId, channelId, dailyLimit: 1, currency: "USD" },
    });
  });
  afterAll(async (): Promise<void> => {
    if (!db) return;
    await db.workspace.delete({ where: { id: workspaceId } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  it("settles a successful reservation and persists prompt provenance", async () => {
    if (!db) return;
    const result = await service.generate(context, {
      approvedIdeaSnapshotId: snapshotId,
      approvedIdeaChecksum: "checksum",
      prompt: "durable prompt",
      channelId,
    });
    const row = await db.script.findFirst({ where: { workspaceId }, include: { revisions: true } });
    const budget = await db.providerBudget.findUnique({ where: { id: budgetId } });
    expect(result).toBeDefined();
    expect(row?.revisions[0]?.promptText).toBe("durable prompt");
    expect(budget?.reserved.toString()).toBe("0");
    expect(budget?.spent.toString()).toBe("1");
  });
  it("blocks concurrent dispatches at the persisted daily cap", async () => {
    if (!db) return;
    await db.providerBudget.update({
      where: { id: budgetId },
      data: { reserved: 0, spent: 0, periodStart: new Date() },
    });
    await expect(
      Promise.all([
        service.generate(context, {
          approvedIdeaSnapshotId: snapshotId,
          approvedIdeaChecksum: "checksum",
          prompt: "one",
          channelId,
        }),
        service.generate(context, {
          approvedIdeaSnapshotId: snapshotId,
          approvedIdeaChecksum: "checksum",
          prompt: "two",
          channelId,
        }),
      ]),
    ).rejects.toThrow("daily budget");
  });
  it("denies foreign script reads and keeps approved exports immutable", async () => {
    if (!db) return;
    const row = await db.script.findFirstOrThrow({ where: { workspaceId } });
    await expect(service.get({ ...context, workspaceId: randomUUID() }, row.id)).rejects.toThrow(
      "Script not found",
    );
    await service.approve(context, row.id);
    await expect(service.revise(context, row.id, document)).rejects.toThrow("immutable");
    const exported = await service.exportApproved(context, row.id);
    expect(exported).toMatchObject({ scriptId: row.id, revision: 1 });
  });
});
