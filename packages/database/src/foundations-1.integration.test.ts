import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foundationFixture } from "./foundations.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Wave 0 workspace boundary 1", () => {
  const { db, foreign, channelId, briefId, runId, ids, scoped } = foundationFixture();
  it("workspaceFoundationDefaults: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.workspaceFoundationDefaults!;
    expect(await scoped.workspaceFoundationDefaults.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.workspaceFoundationDefaults.findMany()).toEqual([]);
    await expect(
      scoped.workspaceFoundationDefaults.findMany({ where: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.workspaceFoundationDefaults.create({ data: { workspaceId: foreign, settings: {} } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.workspaceFoundationDefaults.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.workspaceFoundationDefaults.upsert({
        where: { id },
        create: { workspaceId: foreign, settings: {} },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.workspaceFoundationDefaults.delete({ where: { id } })).rejects.toThrow();
    expect(await db.workspaceFoundationDefaults.findUnique({ where: { id } })).not.toBeNull();
  });
  it("formatTemplate: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.formatTemplate!;
    expect(await scoped.formatTemplate.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.formatTemplate.findMany()).toEqual([]);
    await expect(
      scoped.formatTemplate.findMany({ where: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.formatTemplate.create({
        data: { workspaceId: foreign, key: "explainer", name: "Explainer", structure: {} },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.formatTemplate.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.formatTemplate.upsert({
        where: { id },
        create: { workspaceId: foreign, key: "explainer", name: "Explainer", structure: {} },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.formatTemplate.delete({ where: { id } })).rejects.toThrow();
    expect(await db.formatTemplate.findUnique({ where: { id } })).not.toBeNull();
  });
  it("channelBrief: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.channelBrief!;
    expect(await scoped.channelBrief.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.channelBrief.findMany()).toEqual([]);
    await expect(scoped.channelBrief.findMany({ where: { workspaceId: foreign } })).rejects.toThrow(
      "Cross-workspace",
    );
    await expect(
      scoped.channelBrief.create({
        data: { workspaceId: foreign, channelId, version: 1, document: {} },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.channelBrief.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.channelBrief.upsert({
        where: { id },
        create: { workspaceId: foreign, channelId, version: 1, document: {} },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.channelBrief.delete({ where: { id } })).rejects.toThrow();
    expect(await db.channelBrief.findUnique({ where: { id } })).not.toBeNull();
  });
  it("videoRun: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.videoRun!;
    expect(await scoped.videoRun.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.videoRun.findMany()).toEqual([]);
    await expect(scoped.videoRun.findMany({ where: { workspaceId: foreign } })).rejects.toThrow(
      "Cross-workspace",
    );
    await expect(
      scoped.videoRun.create({
        data: {
          workspaceId: foreign,
          channelId,
          channelBriefId: briefId,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          inputSnapshot: {},
        },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.videoRun.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.videoRun.upsert({
        where: { id },
        create: {
          workspaceId: foreign,
          channelId,
          channelBriefId: briefId,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          inputSnapshot: {},
        },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.videoRun.delete({ where: { id } })).rejects.toThrow();
    expect(await db.videoRun.findUnique({ where: { id } })).not.toBeNull();
  });
  it("videoRunStep: rejects foreign reads, creates, updates, upserts and deletes", async () => {
    const id = ids.videoRunStep!;
    expect(await scoped.videoRunStep.findUnique({ where: { id } })).toBeNull();
    expect(await scoped.videoRunStep.findMany()).toEqual([]);
    await expect(scoped.videoRunStep.findMany({ where: { workspaceId: foreign } })).rejects.toThrow(
      "Cross-workspace",
    );
    await expect(
      scoped.videoRunStep.create({
        data: {
          workspaceId: foreign,
          runId,
          key: "script",
          idempotencyKey: randomUUID(),
          input: {},
        },
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.videoRunStep.update({ where: { id }, data: { workspaceId: foreign } }),
    ).rejects.toThrow("Cross-workspace");
    await expect(
      scoped.videoRunStep.upsert({
        where: { id },
        create: {
          workspaceId: foreign,
          runId,
          key: "script",
          idempotencyKey: randomUUID(),
          input: {},
        },
        update: {},
      }),
    ).rejects.toThrow("Cross-workspace");
    await expect(scoped.videoRunStep.delete({ where: { id } })).rejects.toThrow();
    expect(await db.videoRunStep.findUnique({ where: { id } })).not.toBeNull();
  });
});
