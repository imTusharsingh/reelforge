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
  const ideaB = randomUUID();

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
    expect(await service.list(context)).toEqual([]);
    await expect(service.transition(context, ideaB, "APPROVED")).rejects.toThrow("Idea not found");
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
  });
});
