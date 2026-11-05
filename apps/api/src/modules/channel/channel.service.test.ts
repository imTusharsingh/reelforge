import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ChannelService, configurationFromRow } from "./channel.service.js";

const context = (
  workspaceId: string,
  role: WorkspaceContext["role"] = "OWNER",
): WorkspaceContext => ({
  workspaceId,
  userId: "user-1",
  role,
});

function database(channel: {
  id: string;
  workspaceId: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
}): Database {
  return {
    channel: {
      findFirst: async ({ where }: { where: { workspaceId: string; id: string } }) =>
        where.workspaceId === channel.workspaceId && where.id === channel.id ? channel : null,
    },
  } as unknown as Database;
}

describe("ChannelService tenant and autonomy boundaries", () => {
  it("accepts nullable optional fields from a persisted minimal channel", () => {
    expect(
      configurationFromRow({
        name: "Minimal channel",
        handle: null,
        description: null,
        niche: null,
        language: null,
        audience: null,
        timezone: "UTC",
        goals: null,
        schedule: null,
        automationDefaults: null,
        approvalPolicy: null,
        publishingDestinations: null,
      }),
    ).toEqual({ name: "Minimal channel", timezone: "UTC" });
  });

  it("denies a cross-workspace channel lookup", async () => {
    const service = new ChannelService(database({ id: "c1", workspaceId: "w1", status: "ACTIVE" }));
    await expect(service.get(context("w2"), "c1")).rejects.toThrow("Channel not found");
  });

  it("blocks autonomous work when a channel is paused", async () => {
    const service = new ChannelService(database({ id: "c1", workspaceId: "w1", status: "PAUSED" }));
    await expect(
      service.assertChannelAllowsAutonomousWork(context("w1"), "c1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies viewer channel mutation before touching the database", async () => {
    const service = new ChannelService(database({ id: "c1", workspaceId: "w1", status: "ACTIVE" }));
    await expect(service.setStatus(context("w1", "VIEWER"), "c1", "PAUSED")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
