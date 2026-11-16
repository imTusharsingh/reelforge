import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foundationFixture } from "./foundations.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Wave 0 workspace boundary 2", () => {
  const { db, foreign, runId, ids, scoped } = foundationFixture();
  it("shotSpec: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.shotSpec!;
    expect(await scoped.shotSpec.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.shotSpec.findMany()).toEqual([]);
    await expect(scoped.shotSpec.findMany({ where: { workspaceId: foreign } })).rejects.toThrow(
      "Cross-workspace",
    );
    await expect(
      scoped.shotSpec.create({ data: { workspaceId: foreign, runId, ordinal: 0, document: {} } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.shotSpec.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.shotSpec.upsert({
        where: { id },
        create: { workspaceId: foreign, runId, ordinal: 0, document: {} },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.shotSpec.delete({ where: { id } })).rejects.toThrow();
    expect(await db.shotSpec.findUnique({ where: { id } })).not.toBeNull();
  });
  it("providerCapability: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.providerCapability!;
    expect(await scoped.providerCapability.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.providerCapability.findMany()).toEqual([]);
    await expect(
      scoped.providerCapability.findMany({ where: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.providerCapability.create({
        data: {
          workspaceId: foreign,
          providerId: "fixture",
          modelId: "fixture",
          kind: "VIDEO",
          document: {},
        },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.providerCapability.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.providerCapability.upsert({
        where: { id },
        create: {
          workspaceId: foreign,
          providerId: "fixture",
          modelId: "fixture",
          kind: "VIDEO",
          document: {},
        },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.providerCapability.delete({ where: { id } })).rejects.toThrow();
    expect(await db.providerCapability.findUnique({ where: { id } })).not.toBeNull();
  });
  it("runEvent: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.runEvent!;
    expect(await scoped.runEvent.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.runEvent.findMany()).toEqual([]);
    await expect(scoped.runEvent.findMany({ where: { workspaceId: foreign } })).rejects.toThrow(
      "Cross-workspace",
    );
    await expect(
      scoped.runEvent.create({
        data: {
          workspaceId: foreign,
          runId,
          sequence: 1,
          type: "created",
          correlationId: randomUUID(),
          payload: {},
        },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.runEvent.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.runEvent.upsert({
        where: { id },
        create: {
          workspaceId: foreign,
          runId,
          sequence: 1,
          type: "created",
          correlationId: randomUUID(),
          payload: {},
        },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.runEvent.delete({ where: { id } })).rejects.toThrow();
    expect(await db.runEvent.findUnique({ where: { id } })).not.toBeNull();
  });
  it("budgetEnvelope: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.budgetEnvelope!;
    expect(await scoped.budgetEnvelope.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.budgetEnvelope.findMany()).toEqual([]);
    await expect(
      scoped.budgetEnvelope.findMany({ where: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.budgetEnvelope.create({ data: { workspaceId: foreign, runId } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.budgetEnvelope.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.budgetEnvelope.upsert({
        where: { id },
        create: { workspaceId: foreign, runId },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.budgetEnvelope.delete({ where: { id } })).rejects.toThrow();
    expect(await db.budgetEnvelope.findUnique({ where: { id } })).not.toBeNull();
  });
  it("referenceAsset: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.referenceAsset!;
    expect(await scoped.referenceAsset.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.referenceAsset.findMany()).toEqual([]);
    await expect(
      scoped.referenceAsset.findMany({ where: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.referenceAsset.create({
        data: {
          workspaceId: foreign,
          referenceId: randomUUID(),
          kind: "SCENERY",
          source: "UPLOADED",
          checksumSha256: "a".repeat(64),
          document: {},
        },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.referenceAsset.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.referenceAsset.upsert({
        where: { id },
        create: {
          workspaceId: foreign,
          referenceId: randomUUID(),
          kind: "SCENERY",
          source: "UPLOADED",
          checksumSha256: "a".repeat(64),
          document: {},
        },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.referenceAsset.delete({ where: { id } })).rejects.toThrow();
    expect(await db.referenceAsset.findUnique({ where: { id } })).not.toBeNull();
  });
});
