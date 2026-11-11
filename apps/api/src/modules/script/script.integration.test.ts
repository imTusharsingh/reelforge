import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { ProviderRegistry } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ScriptService } from "./script.service.js";
import { compilePrompt, parsePromptTemplateBody, platformDefaults } from "@reelforge/config-engine";
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
const configSnapshotId = randomUUID();
const promptSnapshotId = randomUUID();
const templateId = randomUUID();
const templateVersionId = randomUUID();
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
        credential: {
          providerId: "fixture",
          environment: process.env.NODE_ENV === "production" ? "production" : "development",
          secret: "fixture-secret",
        },
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
        safetyProfile: { requiresSourceBackedClaims: false },
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
    const body = parsePromptTemplateBody({
      sections: { instructions: "Write a structured script for {{topic}}." },
      variables: [{ name: "topic", required: true }],
      allowedAdditionSections: ["instructions"],
    });
    const bundle = compilePrompt({
      config: platformDefaults,
      template: {
        templateId,
        templateKey: "fixture-script",
        templateName: "Fixture script",
        versionId: templateVersionId,
        version: 1,
        checksumSha256: "a".repeat(64),
        body,
      },
      variables: { topic: "approved topic" },
    });
    await db.promptTemplate.create({
      data: { id: templateId, workspaceId, key: "fixture-script", name: "Fixture script" },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: templateVersionId,
        workspaceId,
        templateId,
        version: 1,
        status: "PUBLISHED",
        body,
        checksumSha256: "a".repeat(64),
      },
    });
    await db.configSnapshot.create({
      data: {
        id: configSnapshotId,
        workspaceId,
        version: 1,
        config: platformDefaults,
        fingerprintSha256: "b".repeat(64),
        resolutionSha256: "c".repeat(64),
        layers: [],
        lockedFields: [],
      },
    });
    await db.promptBundleSnapshot.create({
      data: {
        id: promptSnapshotId,
        workspaceId,
        version: 1,
        configSnapshotId,
        templateId,
        templateVersionId,
        bundle,
        fingerprintSha256: bundle.fingerprintSha256,
      },
    });
    await db.providerBudget.create({
      data: { id: budgetId, workspaceId, channelId, dailyLimit: 1, currency: "USD" },
    });
  });
  afterAll(async (): Promise<void> => {
    if (!db) return;
    await db.scriptRevision.deleteMany({ where: { workspaceId } });
    await db.script.deleteMany({ where: { workspaceId } });
    await db.promptBundleSnapshot.deleteMany({ where: { workspaceId } });
    await db.configSnapshot.deleteMany({ where: { workspaceId } });
    await db.ideaApprovalSnapshot.deleteMany({ where: { workspaceId } });
    await db.idea.deleteMany({ where: { workspaceId } });
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
      configSnapshotId,
      promptSnapshotId,
    });
    const row = await db.script.findFirst({ where: { workspaceId }, include: { revisions: true } });
    const budget = await db.providerBudget.findUnique({ where: { id: budgetId } });
    expect(result).toBeDefined();
    expect(row?.revisions[0]?.promptText).toContain("durable prompt");
    expect(row?.revisions[0]?.promptText).toContain(
      "Write a structured script for approved topic.",
    );
    const ledger = await db.providerRequest.findFirstOrThrow({ where: { workspaceId } });
    expect(ledger.dispatchedPrompt).toBe(row?.revisions[0]?.promptText);
    expect(ledger.estimatedCost?.toString()).toBe("1");
    expect(ledger.actualCost?.toString()).toBe("1");
    expect(budget?.reserved.toString()).toBe("0");
    expect(budget?.spent.toString()).toBe("1");
  });
  it("rejects correlation replay without a duplicate reservation", async () => {
    if (!db) return;
    const existing = await db.providerRequest.findFirstOrThrow({ where: { workspaceId } });
    await expect(
      service.generate(context, {
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt: "replay",
        channelId,
        configSnapshotId,
        promptSnapshotId,
        correlationId: existing.correlationId,
      }),
    ).rejects.toThrow();
    expect(
      await db.providerBudgetReservation.count({
        where: { correlationId: existing.correlationId },
      }),
    ).toBe(1);
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
          configSnapshotId,
          promptSnapshotId,
        }),
        service.generate(context, {
          approvedIdeaSnapshotId: snapshotId,
          approvedIdeaChecksum: "checksum",
          prompt: "two",
          channelId,
          configSnapshotId,
          promptSnapshotId,
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
    await service.approve(context, row.id, row.currentRevision);
    await expect(service.revise(context, row.id, document, row.currentRevision)).rejects.toThrow("immutable");
    const exported = await service.exportApproved(context, row.id);
    expect(exported).toMatchObject({ scriptId: row.id, revision: 1 });
  });

  it("atomically binds approve to the validated revision under concurrency", async () => {
    if (!db) return;
    await db.providerBudget.update({
      where: { id: budgetId },
      data: { reserved: 0, spent: 0, periodStart: new Date() },
    });
    await service.generate(context, {
      approvedIdeaSnapshotId: snapshotId,
      approvedIdeaChecksum: "checksum",
      prompt: "race setup",
      channelId,
      configSnapshotId,
      promptSnapshotId,
    });
    const row = await db.script.findFirstOrThrow({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    const results = await Promise.allSettled([
      service.approve(context, row.id, row.currentRevision),
      service.revise(context, row.id, document, row.currentRevision),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const final = await db.script.findUniqueOrThrow({
      where: { id: row.id },
      include: { revisions: true },
    });
    expect(final.revisions).toHaveLength(final.currentRevision);
    if (final.status === "APPROVED") expect(final.currentRevision).toBe(1);
  });

  it("requires a paired snapshot and rejects a cross-tenant provenance FK", async () => {
    if (!db) return;
    await expect(
      service.generate(context, {
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt: "missing",
        channelId,
      }),
    ).rejects.toThrow("Bad Request");
    const foreignWorkspaceId = randomUUID();
    await db.workspace.create({ data: { id: foreignWorkspaceId, name: "foreign-provenance" } });
    const revision = await db.scriptRevision.findFirstOrThrow({ where: { workspaceId } });
    await expect(
      db.scriptRevision.update({
        where: { id: revision.id },
        data: { workspaceId: foreignWorkspaceId },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await db.workspace.delete({ where: { id: foreignWorkspaceId } });
  });

  it("records every failed call field and releases a provider rejection", async () => {
    if (!db) return;
    await db.providerBudget.update({
      where: { id: budgetId },
      data: { reserved: 0, spent: 0, periodStart: new Date() },
    });
    const failing: ScriptLlmPort = {
      ...llm,
      complete: async (): Promise<Awaited<ReturnType<ScriptLlmPort["complete"]>>> => {
        throw new Error("fixture rejection");
      },
    };
    const failingRegistry = new ProviderRegistry();
    failingRegistry.register({
      capability: llm.capability,
      credential: { providerId: "fixture", environment: "development", secret: "fixture-secret" },
    });
    const failingService = new ScriptService(db as Database, failing, failingRegistry);
    const correlationId = randomUUID();
    await expect(
      failingService.generate(context, {
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt: "failure",
        channelId,
        configSnapshotId,
        promptSnapshotId,
        correlationId,
      }),
    ).rejects.toThrow("fixture rejection");
    const ledger = await db.providerRequest.findUniqueOrThrow({
      where: { workspaceId_correlationId: { workspaceId, correlationId } },
    });
    expect(ledger).toMatchObject({ status: "FAILED", channelId, currency: "USD", usage: null });
    expect(ledger.estimatedCost?.toString()).toBe("1");
    expect(ledger.actualCost).toBeNull();
    expect(ledger.latencyMs).toEqual(expect.any(Number));
    expect(ledger.responseMetadata).toMatchObject({ costKnown: false, dispatched: true });
    expect(ledger.errorCode).toBe("Error");
    expect(ledger.errorMessage).toBe("fixture rejection");
    const budget = await db.providerBudget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(budget.reserved.toString()).toBe("0");
    expect(budget.spent.toString()).toBe("0");
    expect(
      (await db.providerBudgetReservation.findFirstOrThrow({ where: { correlationId } })).status,
    ).toBe("RELEASED");
  });

  it("keeps a prior-day response auditable across reset without charging the new day", async () => {
    if (!db) return;
    await db.providerBudget.update({
      where: { id: budgetId },
      data: { reserved: 0, spent: 0, periodStart: new Date() },
    });
    let day = new Date("2026-01-01T23:59:00.000Z");
    let release!: () => void;
    const hold = new Promise<void>((resolve): void => {
      release = resolve;
    });
    const delayed: ScriptLlmPort = {
      ...llm,
      complete: async (): Promise<Awaited<ReturnType<ScriptLlmPort["complete"]>>> => {
        await hold;
        return {
          output: document,
          metadata: {
            modelVersion: "model",
            promptVersion: "prompt",
            cost: 0.2,
            currency: "USD",
            usage: { inputTokens: 3 },
          },
        };
      },
    };
    const registry = new ProviderRegistry();
    registry.register({
      capability: llm.capability,
      credential: { providerId: "fixture", environment: "development", secret: "fixture-secret" },
    });
    const first = new ScriptService(db as Database, delayed, registry, () => day);
    const correlationId = randomUUID();
    const pending = first.generate(context, {
      approvedIdeaSnapshotId: snapshotId,
      approvedIdeaChecksum: "checksum",
      prompt: "midnight",
      channelId,
      configSnapshotId,
      promptSnapshotId,
      correlationId,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    day = new Date("2026-01-02T00:01:00.000Z");
    const second = new ScriptService(
      db as Database,
      {
        ...llm,
        complete: async (): Promise<Awaited<ReturnType<ScriptLlmPort["complete"]>>> => {
          throw new Error("next day fails");
        },
      },
      registry,
      () => day,
    );
    await expect(
      second.generate(context, {
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt: "next day",
        channelId,
        configSnapshotId,
        promptSnapshotId,
        correlationId: randomUUID(),
      }),
    ).rejects.toThrow("next day fails");
    const beforeFinish = await db.providerBudget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(beforeFinish.spent.toString()).toBe("0");
    expect(beforeFinish.reserved.toString()).toBe("0");
    release();
    await pending;
    const after = await db.providerBudget.findUniqueOrThrow({ where: { id: budgetId } });
    expect(after.reserved.toString()).toBe("0");
    expect(after.spent.toString()).toBe("0");
    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { correlationId },
    });
    expect(reservation.status).toBe("SETTLED");
    expect(reservation.actualCost?.toString()).toBe("0.2");
    expect(reservation.chargedCost?.toString()).toBe("0.2");
    const ledger = await db.providerRequest.findUniqueOrThrow({
      where: { workspaceId_correlationId: { workspaceId, correlationId } },
    });
    expect(ledger.usage).toMatchObject({ inputTokens: 3 });
    expect(ledger.estimatedCost?.toString()).toBe("1");
    expect(ledger.actualCost?.toString()).toBe("0.2");
  });

  it("does not mutate tenant-owned reservation state for another workspace", async () => {
    if (!db) return;
    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { workspaceId },
    });
    await expect(
      service.generate(
        { ...context, workspaceId: randomUUID() },
        {
          approvedIdeaSnapshotId: snapshotId,
          approvedIdeaChecksum: "checksum",
          prompt: "foreign",
          configSnapshotId,
          promptSnapshotId,
          correlationId: reservation.correlationId!,
        },
      ),
    ).rejects.toThrow();
    expect(
      (await db.providerBudgetReservation.findUniqueOrThrow({ where: { id: reservation.id } }))
        .workspaceId,
    ).toBe(workspaceId);
  });
  it("records malformed output with settled unknown cost and no script write", async () => {
    if (!db) return;
    await db.providerBudget.update({
      where: { id: budgetId },
      data: { reserved: 0, spent: 0, periodStart: new Date() },
    });
    const malformed: ScriptLlmPort = {
      ...llm,
      complete: async (): Promise<Awaited<ReturnType<ScriptLlmPort["complete"]>>> => ({
        output: { invalid: true },
        metadata: {
          modelVersion: "model",
          promptVersion: "prompt",
          cost: null,
          usage: { inputTokens: 2 },
        },
      }),
    };
    const registry = new ProviderRegistry();
    registry.register({
      capability: llm.capability,
      credential: { providerId: "fixture", environment: "development", secret: "fixture-secret" },
    });
    const correlationId = randomUUID();
    await expect(
      new ScriptService(db as Database, malformed, registry).generate(context, {
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt: "malformed",
        channelId,
        configSnapshotId,
        promptSnapshotId,
        correlationId,
      }),
    ).rejects.toThrow();
    const ledger = await db.providerRequest.findUniqueOrThrow({
      where: { workspaceId_correlationId: { workspaceId, correlationId } },
    });
    expect(ledger.status).toBe("FAILED");
    expect(ledger.estimatedCost?.toString()).toBe("1");
    expect(ledger.actualCost).toBeNull();
    expect(ledger.usage).toMatchObject({ inputTokens: 2 });
    expect(ledger.responseMetadata).toMatchObject({ costKnown: false });
    expect(ledger.channelId).toBe(channelId);
    expect(ledger.latencyMs).toEqual(expect.any(Number));
    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { correlationId },
    });
    expect(reservation.status).toBe("SETTLED");
    expect(reservation.chargedCost?.toString()).toBe("1");
    expect(
      await db.script.count({
        where: { workspaceId, revisions: { some: { promptText: { contains: "malformed" } } } },
      }),
    ).toBe(0);
  });

  it("records invalid provenance and settles conservatively", async () => {
    if (!db) return;
    await db.providerBudget.update({
      where: { id: budgetId },
      data: { reserved: 0, spent: 0, periodStart: new Date() },
    });
    const invalid: ScriptLlmPort = {
      ...llm,
      complete: async (): Promise<Awaited<ReturnType<ScriptLlmPort["complete"]>>> => ({
        output: document,
        metadata: { modelVersion: "", promptVersion: "", cost: null },
      }),
    };
    const registry = new ProviderRegistry();
    registry.register({
      capability: llm.capability,
      credential: { providerId: "fixture", environment: "development", secret: "fixture-secret" },
    });
    const correlationId = randomUUID();
    await expect(
      new ScriptService(db as Database, invalid, registry).generate(context, {
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt: "provenance",
        channelId,
        configSnapshotId,
        promptSnapshotId,
        correlationId,
      }),
    ).rejects.toThrow("invalid provenance");
    const ledger = await db.providerRequest.findUniqueOrThrow({
      where: { workspaceId_correlationId: { workspaceId, correlationId } },
    });
    expect(ledger.status).toBe("FAILED");
    expect(ledger.errorMessage).toContain("invalid provenance");
    expect(ledger.actualCost).toBeNull();
    expect(ledger.responseMetadata).toMatchObject({ costKnown: false });
    expect(
      (
        await db.providerBudgetReservation.findFirstOrThrow({ where: { correlationId } })
      ).chargedCost?.toString(),
    ).toBe("1");
  });

  it.each(["missing", "null"] as const)(
    "persists a complete failed ledger with %s provider metadata",
    async (metadataKind): Promise<void> => {
      if (!db) return;
      await db.providerBudget.update({
        where: { id: budgetId },
        data: { reserved: 0, spent: 0, periodStart: new Date() },
      });
      const malformedEnvelope: ScriptLlmPort = {
        ...llm,
        complete: async (): Promise<Awaited<ReturnType<ScriptLlmPort["complete"]>>> =>
          ({
            output: document,
            providerRequestId: "external-request",
            ...(metadataKind === "missing" ? {} : { metadata: null }),
          }) as unknown as Awaited<ReturnType<ScriptLlmPort["complete"]>>,
      };
      const registry = new ProviderRegistry();
      registry.register({
        capability: llm.capability,
        credential: { providerId: "fixture", environment: "development", secret: "fixture-secret" },
      });
      const correlationId = randomUUID();
      await expect(
        new ScriptService(db as Database, malformedEnvelope, registry).generate(context, {
          approvedIdeaSnapshotId: snapshotId,
          approvedIdeaChecksum: "checksum",
          prompt: `metadata-${metadataKind}`,
          channelId,
          configSnapshotId,
          promptSnapshotId,
          correlationId,
        }),
      ).rejects.toThrow("invalid provenance");
      const ledger = await db.providerRequest.findUniqueOrThrow({
        where: { workspaceId_correlationId: { workspaceId, correlationId } },
      });
      expect(ledger).toMatchObject({
        status: "FAILED",
        channelId,
        currency: "USD",
        usage: null,
        actualCost: null,
        correlationId,
        responseMetadata: {
          dispatched: true,
          providerRequestId: "external-request",
          modelVersion: null,
          promptVersion: null,
          costKnown: false,
        },
        errorCode: "ConflictException",
      });
      expect(ledger.estimatedCost?.toString()).toBe("1");
      expect(ledger.dispatchedPrompt).toContain(`metadata-${metadataKind}`);
      expect(ledger.errorMessage).toContain("invalid provenance");
      expect(ledger.latencyMs).toEqual(expect.any(Number));
      const reservation = await db.providerBudgetReservation.findFirstOrThrow({
        where: { correlationId },
      });
      expect(reservation.status).toBe("SETTLED");
      expect(reservation.actualCost).toBeNull();
      expect(reservation.chargedCost?.toString()).toBe("1");
      expect(
        await db.script.count({
          where: { revisions: { some: { promptText: { contains: `metadata-${metadataKind}` } } } },
        }),
      ).toBe(0);
    },
  );

  it("retains a failed-dispatch ledger after a real script persistence error", async () => {
    if (!db) return;
    const correlationId = randomUUID();
    const failingDb = db.$extends({
      query: {
        script: {
          async create(): Promise<never> {
            throw new Error("fixture script persistence failure");
          },
        },
      },
    });
    const persistenceService = new ScriptService(
      failingDb as unknown as Database,
      llm,
      ((): ProviderRegistry => {
        const registry = new ProviderRegistry();
        registry.register({
          capability: llm.capability,
          credential: {
            providerId: "fixture",
            environment: "development",
            secret: "fixture-secret",
          },
        });
        return registry;
      })(),
    );
    await db.providerBudget.update({
      where: { id: budgetId },
      data: { reserved: 0, spent: 0, periodStart: new Date() },
    });
    await expect(
      persistenceService.generate(context, {
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt: "persist",
        channelId,
        configSnapshotId,
        promptSnapshotId,
        correlationId,
      }),
    ).rejects.toThrow("fixture script persistence failure");
    const ledger = await db.providerRequest.findUniqueOrThrow({
      where: { workspaceId_correlationId: { workspaceId, correlationId } },
    });
    expect(ledger.status).toBe("FAILED");
    expect(ledger.actualCost?.toString()).toBe("1");
    expect(ledger.estimatedCost?.toString()).toBe("1");
    expect(ledger.errorMessage).toBe("fixture script persistence failure");
    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { correlationId },
    });
    expect(reservation.status).toBe("SETTLED");
    expect(reservation.actualCost?.toString()).toBe("1");
  });
});
