import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "@reelforge/database";
import { defaultBrief } from "@reelforge/contracts";
import { BriefService } from "./brief.service.js";
import { BriefApprovals } from "./brief-approvals.js";
import { BriefController } from "./brief.controller.js";
import type { WorkspaceService } from "../workspace/workspace.service.js";
import type { AuthenticatedRequest } from "../identity/auth.guard.js";
const enabled = Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("V7 persisted Brief versions", () => {
  const db = createDatabaseClient(process.env.DATABASE_URL ?? "postgresql://unused");
  const workspaceId = randomUUID(),
    foreign = randomUUID(),
    channelId = randomUUID();
  const context = { workspaceId, userId: randomUUID(), role: "OWNER" as const };
  const count = vi.fn().mockResolvedValue(0);
  const service = new BriefService(db, { count });
  const input = defaultBrief({
    niche: "Science",
    audience: "Adults",
    language: "English",
    voiceId: "Kore",
    cadence: { shortsPerDay: 1, localTime: "18:00", timezone: "UTC" },
  });
  beforeAll(async () => {
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "V7" },
        { id: foreign, name: "Foreign" },
      ],
    });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "Science" } });
  });
  afterAll(async () => {
    await db.workspace.deleteMany({ where: { id: { in: [workspaceId, foreign] } } });
    await db.$disconnect();
  });
  it("appends immutable versions and returns newest first", async () => {
    const first = await service.create(context, channelId, input);
    const second = await service.create(context, channelId, { ...input, topic: "Space" });
    expect(second.version).toBe(first.version + 1);
    expect(second.id).not.toBe(first.id);
    const versions = await service.list(context, channelId);
    expect(versions.map((row) => row.topic)).toEqual(["Space", "Science"]);
    expect((await db.channelBrief.findUniqueOrThrow({ where: { id: first.id } })).document).toEqual(
      first,
    );
  });
  it("rejects foreign reads, writes, eligibility, viewers and forged identity", async () => {
    const other = { ...context, workspaceId: foreign };
    await expect(service.list(other, channelId)).rejects.toThrow("Channel not found");
    await expect(service.create(other, channelId, input)).rejects.toThrow("Channel not found");
    await expect(service.eligibility(other, channelId)).rejects.toThrow("Channel not found");
    await expect(service.create({ ...context, role: "VIEWER" }, channelId, input)).rejects.toThrow(
      "Editor permission",
    );
    await expect(
      service.create(context, channelId, { ...input, workspaceId: foreign }),
    ).rejects.toThrow();
  });
  it("counts channel approvals through the V3 seam, with the ten-approval boundary", async () => {
    expect(await new BriefApprovals(db).count(context, channelId)).toBe(0);
    count.mockResolvedValue(9);
    await expect(
      service.create(context, channelId, { ...input, requestedAutonomy: "L3" }),
    ).rejects.toThrow("10 approved");
    expect(await service.eligibility(context, channelId)).toEqual({
      approvedShorts: 9,
      offerL3: false,
    });
    count.mockResolvedValue(10);
    expect(
      (await service.create(context, channelId, { ...input, requestedAutonomy: "L3" }))
        .requestedAutonomy,
    ).toBe("L3");
    expect(await service.eligibility(context, channelId)).toEqual({
      approvedShorts: 10,
      offerL3: true,
    });
    expect(count).toHaveBeenCalledWith(context, channelId);
  });
  it("counts only distinct runs with a final approval on this channel", async () => {
    const brief = await service.create(context, channelId, input);
    const run = await db.videoRun.create({
      data: {
        workspaceId,
        channelId,
        channelBriefId: brief.id,
        channelBriefVersion: brief.version,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        inputSnapshot: {},
      },
    });
    await db.runEvent.createMany({
      data: ["stage_approved", "approved", "approved"].map((type, index) => ({
        workspaceId,
        runId: run.id,
        sequence: index + 1,
        type,
        correlationId: run.correlationId,
        payload: {},
      })),
    });
    const approvals = new BriefApprovals(db);
    expect(await approvals.count(context, channelId)).toBe(1);
    expect(await approvals.count({ ...context, workspaceId: foreign }, channelId)).toBe(0);
  });
  it("resolves workspace membership on every controller operation", async () => {
    const resolve = vi.fn().mockResolvedValue(context);
    const controller = new BriefController(service, {
      context: resolve,
    } as unknown as WorkspaceService);
    const request = { principal: { userId: context.userId } } as AuthenticatedRequest;
    await controller.list(request, workspaceId, channelId);
    await controller.eligibility(request, workspaceId, channelId);
    await controller.create(request, workspaceId, channelId, input);
    expect(resolve).toHaveBeenCalledTimes(3);
    resolve.mockRejectedValue(new Error("denied"));
    await expect(controller.list(request, foreign, channelId)).rejects.toThrow("denied");
  });
});
