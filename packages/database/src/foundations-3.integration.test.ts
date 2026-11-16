import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seedWorkspaceFoundations, foundationWorkspaceGuard } from "./foundation-workspace.js";
import { foundationFixture } from "./foundations.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Wave 0 workspace boundary 3", () => {
  const { db, own, foreign, channelId, briefId, runId, ids, scoped } = foundationFixture();
  it("channelReferenceDefaults: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.channelReferenceDefaults!;
    expect(await scoped.channelReferenceDefaults.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.channelReferenceDefaults.findMany()).toEqual([]);
    await expect(
      scoped.channelReferenceDefaults.findMany({ where: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.channelReferenceDefaults.create({
        data: { workspaceId: foreign, channelId, document: {} },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.channelReferenceDefaults.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.channelReferenceDefaults.upsert({
        where: { id },
        create: { workspaceId: foreign, channelId, document: {} },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.channelReferenceDefaults.delete({ where: { id } })).rejects.toThrow();
    expect(await db.channelReferenceDefaults.findUnique({ where: { id } })).not.toBeNull();
  });
  it("composite foreign keys reject references to another workspace", async () => {
    await expect(
      db.videoRun.create({
        data: {
          workspaceId: own,
          channelId,
          channelBriefId: briefId,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          inputSnapshot: {},
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.runEvent.create({
        data: {
          workspaceId: own,
          runId,
          sequence: 9,
          type: "forged",
          correlationId: randomUUID(),
          payload: {},
        },
      }),
    ).rejects.toThrow();
  });
  it("reference versions cannot be mutated and envelopes enforce the hard cap", async () => {
    await expect(
      db.referenceAsset.update({
        where: { id: ids.referenceAsset! },
        data: { document: { changed: true } },
      }),
    ).rejects.toThrow("immutable");
    await expect(
      db.budgetEnvelope.update({ where: { id: ids.budgetEnvelope! }, data: { spentMinor: 801 } }),
    ).rejects.toThrow();
  });
  it("seeds exact defaults and performs no changes on repeat", async () => {
    await seedWorkspaceFoundations(db, own);
    const before = await snapshot();
    await seedWorkspaceFoundations(db, own);
    expect(await snapshot()).toEqual(before);
    const defaults = await db.workspaceFoundationDefaults.findUniqueOrThrow({
      where: { workspaceId: own },
    });
    expect(defaults.settings).toMatchObject({
      autonomy: "L2",
      narrationLanguage: "English",
      aiDisclosure: true,
      cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "CHANNEL" },
      budgetPolicy: {
        currency: "USD",
        targetMinor: 600,
        hardCapMinor: 800,
        dailyLimitMinor: 2000,
        monthlyLimitMinor: 18000,
      },
      renderProfile: { width: 1080, height: 1920, fps: 24, videoCodec: "h264" },
    });
    expect(
      (await db.formatTemplate.findMany({ where: { workspaceId: own } }))
        .map((row) => row.key)
        .sort(),
    ).toEqual([
      "explainer",
      "history-moment",
      "myth-vs-fact",
      "news-recap",
      "quick-how-to",
      "story",
      "top-3",
      "what-if",
    ]);
    expect(await db.promptTemplate.count({ where: { workspaceId: own } })).toBe(9);
    const budget = await db.usageBudget.findFirstOrThrow({ where: { workspaceId: own } });
    expect([budget.dailyLimitMinor, budget.monthlyLimitMinor]).toEqual([2000n, 18000n]);
  });
  it("allows owned CRUD and bulk calls while denying viewers and nested writes", async () => {
    const capability = {
      workspaceId: own,
      providerId: "offline",
      modelId: "v1",
      kind: "TEXT",
      document: {},
    };
    const row = await scoped.providerCapability.create({ data: capability });
    expect(await scoped.providerCapability.findFirst({ where: { id: row.id } })).not.toBeNull();
    await scoped.providerCapability.update({ where: { id: row.id }, data: { enabled: true } });
    await scoped.providerCapability.upsert({
      where: { id: row.id },
      create: capability,
      update: { enabled: false },
    });
    await scoped.providerCapability.createMany({
      data: [
        { ...capability, modelId: "v2" },
        { ...capability, modelId: "v3" },
      ],
    });
    await scoped.providerCapability.updateMany({ data: { enabled: true } });
    expect(await scoped.providerCapability.count()).toBe(3);
    const viewer = foundationWorkspaceGuard(db, {
      workspaceId: own,
      userId: randomUUID(),
      role: "VIEWER",
    });
    expect(await viewer.providerCapability.count()).toBe(3);
    await expect(viewer.providerCapability.create({ data: capability })).rejects.toThrow("Editor");
    await expect(
      scoped.providerCapability.create({
        data: { ...capability, workspace: { connect: { id: foreign } } } as never,
      }),
    ).rejects.toThrow("Nested writes");
    await expect(scoped.providerCapability.findMany({ where: [] as never })).rejects.toThrow(
      "Invalid scoped",
    );
    expect(() =>
      foundationWorkspaceGuard(db, { workspaceId: "", userId: "", role: "OWNER" }),
    ).toThrow("Verified workspace");
    await scoped.providerCapability.deleteMany();
    expect(await scoped.providerCapability.count()).toBe(0);
  });
  async function snapshot(): Promise<string> {
    const rows = await Promise.all([
      db.workspaceFoundationDefaults.findMany({ where: { workspaceId: own } }),
      db.promptTemplate.findMany({ where: { workspaceId: own }, orderBy: { id: "asc" } }),
      db.promptTemplateVersion.findMany({ where: { workspaceId: own }, orderBy: { id: "asc" } }),
      db.promptBundleSnapshot.findMany({ where: { workspaceId: own }, orderBy: { id: "asc" } }),
      db.configSnapshot.findMany({ where: { workspaceId: own } }),
      db.formatTemplate.findMany({ where: { workspaceId: own }, orderBy: { id: "asc" } }),
      db.providerBudget.findMany({ where: { workspaceId: own } }),
      db.usageBudget.findMany({ where: { workspaceId: own } }),
    ]);
    return JSON.stringify(rows, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  }
});
