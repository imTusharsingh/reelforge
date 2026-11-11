import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { IdeaService } from "./idea.service.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

suite("IdeaService Prisma tenant ownership", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const ownerId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const channelA = randomUUID();
  const channelB = randomUUID();
  const seriesA = randomUUID();
  const seriesB = randomUUID();
  const genreA = randomUUID();
  const genreB = randomUUID();
  const ideaB = randomUUID();
  const ideaA = randomUUID();

  beforeAll(async (): Promise<void> => {
    if (!db) return;
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@integration.invalid` } });
    await db.workspace.create({ data: { id: workspaceA, name: "integration-a" } });
    await db.workspace.create({ data: { id: workspaceB, name: "integration-b" } });
    await db.workspaceMembership.create({
      data: { workspaceId: workspaceA, userId: ownerId, role: "OWNER" },
    });
    await db.workspaceMembership.create({
      data: { workspaceId: workspaceB, userId: ownerId, role: "OWNER" },
    });
    await db.channel.create({ data: { id: channelA, workspaceId: workspaceA, name: "A" } });
    await db.channel.create({ data: { id: channelB, workspaceId: workspaceB, name: "B" } });
    await db.genre.create({
      data: {
        id: genreA,
        workspaceId: workspaceA,
        name: "Genre A",
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
    await db.genre.create({
      data: {
        id: genreB,
        workspaceId: workspaceB,
        name: "Genre B",
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
    await db.contentSeries.create({
      data: {
        id: seriesA,
        workspaceId: workspaceA,
        channelId: channelA,
        genreId: genreA,
        name: "Series A",
        format: "short",
        frequency: "weekly",
        characterGroupRefs: [],
        promptRefs: [],
      },
    });
    await db.contentSeries.create({
      data: {
        id: seriesB,
        workspaceId: workspaceB,
        channelId: channelB,
        genreId: genreB,
        name: "Series B",
        format: "short",
        frequency: "weekly",
        characterGroupRefs: [],
        promptRefs: [],
      },
    });
    await db.idea.create({
      data: {
        id: ideaB,
        workspaceId: workspaceB,
        channelId: channelB,
        origin: "USER",
        title: "Foreign",
        normalizedTitle: "foreign",
        topic: "foreign",
        hook: "hook",
        angle: "angle",
        audience: "audience",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        createdByUserId: ownerId,
      },
    });
    await db.idea.create({
      data: {
        id: ideaA,
        workspaceId: workspaceA,
        channelId: channelA,
        seriesId: seriesA,
        origin: "USER",
        title: "Local",
        normalizedTitle: "local",
        topic: "local",
        hook: "hook",
        angle: "angle",
        audience: "audience",
        references: [],
        sourceNotes: null,
        expectedFormat: "short",
        createdByUserId: ownerId,
      },
    });
  });

  afterAll(async (): Promise<void> => {
    if (!db) return;
    await db.workspace.deleteMany({ where: { id: { in: [workspaceA, workspaceB] } } });
    await db.user.delete({ where: { id: ownerId } });
    await db.$disconnect();
  });

  it("scopes list and transition by workspace and rejects a foreign channel", async () => {
    if (!db) return;
    const service = new IdeaService(db as never, {
      proposeIdea: async (): Promise<never> => {
        throw new Error("NotConfigured");
      },
    });
    const context = { workspaceId: workspaceA, userId: ownerId, role: "OWNER" as const };
    const scopedIdeas = await service.list(context);
    expect(scopedIdeas).toEqual([expect.objectContaining({ id: ideaA, workspaceId: workspaceA })]);
    await expect(
      service.transition(context, ideaB, "APPROVED", new Date(), "DRAFT"),
    ).rejects.toThrow("Idea not found");
    await expect(
      service.create(
        context,
        {
          title: "Foreign channel",
          topic: "topic",
          hook: "hook",
          angle: "angle",
          audience: "audience",
          references: [],
          expectedFormat: "short",
          channelId: channelB,
        },
        "USER",
      ),
    ).rejects.toThrow("Channel not found");
    await expect(
      service.create(
        context,
        {
          title: "Foreign series",
          topic: "topic",
          hook: "hook",
          angle: "angle",
          audience: "audience",
          references: [],
          expectedFormat: "short",
          seriesId: seriesB,
        },
        "USER",
      ),
    ).rejects.toThrow("Series not found");
    const expectedUpdatedAt = (await db.idea.findUniqueOrThrow({ where: { id: ideaA } })).updatedAt;
    await expect(
      service.transition(context, ideaA, "APPROVED", expectedUpdatedAt, "DRAFT"),
    ).resolves.toBeDefined();
    await expect(
      service.transition(context, ideaA, "APPROVED", expectedUpdatedAt, "DRAFT"),
    ).rejects.toThrow("Idea changed");
  });

  it("enforces the workspace/channel composite foreign key", async () => {
    if (!db) return;
    await expect(
      db.idea.create({
        data: {
          workspaceId: workspaceA,
          channelId: channelB,
          origin: "USER",
          title: "Invalid FK",
          normalizedTitle: "invalid fk",
          topic: "topic",
          hook: "hook",
          angle: "angle",
          audience: "audience",
          references: [],
          sourceNotes: null,
          expectedFormat: "short",
          createdByUserId: ownerId,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.idea.create({
        data: {
          workspaceId: workspaceA,
          channelId: channelA,
          origin: "USER",
          title: "Invalid creator",
          normalizedTitle: "invalid creator",
          topic: "topic",
          hook: "hook",
          angle: "angle",
          audience: "audience",
          references: [],
          expectedFormat: "short",
          createdByUserId: randomUUID(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.idea.update({
        where: { workspaceId_id: { workspaceId: workspaceA, id: ideaA } },
        data: { seriesId: seriesB },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.ideaDuplicate.create({
        data: {
          workspaceId: workspaceA,
          ideaId: ideaA,
          matchedIdeaId: ideaB,
          reason: "foreign",
          score: 0.5,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
