import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { NotificationEventInput } from "./notifications.sources.js";
import { RunNotifications } from "./run-notifications.js";
import type { Database } from "../identity/identity.types.js";
import type { NotificationsService } from "./notifications.service.js";
import { context, fixture } from "../autonomy/autonomy.fixture.js";
it("runs V8 boundaries and sends approval links plus deduplicated daily digest through M17", async () => {
  const f = fixture();
  const db = {
    workspace: { findMany: vi.fn(async () => [{ id: context.workspaceId }]) },
    workspaceMembership: {
      findFirst: vi.fn(async (): Promise<{ userId: string; role: string } | null> => ({
        userId: context.userId,
        role: "OWNER",
      })),
    },
  };
  const list = vi.fn(async () => [f.run]);
  const scoped = f.service.store.scoped(context);
  Object.assign(scoped, { videoRun: { ...scoped.videoRun, findMany: list } });
  const recordEvents = vi.fn(async (events: readonly NotificationEventInput[]) => events.length);
  const runtime = new RunNotifications(db as unknown as Database, f.service, {
    recordEvents,
  } as unknown as NotificationsService);
  const now = new Date("2026-11-16T12:00:00Z");
  await runtime.tick(now);
  await runtime.tick(now);
  expect(recordEvents).toHaveBeenCalledTimes(2);
  const events = recordEvents.mock.calls[0]?.[0];
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        eventType: "VIDEO_RUN_APPROVAL_REQUESTED",
        link: `/runs/${f.run.id}`,
      }),
      expect.objectContaining({
        eventType: "VIDEO_RUN_DAILY_DIGEST",
        sourceKey: `v8:digest:${f.run.channelId}:2026-11-16`,
      }),
    ]),
  );
  expect(recordEvents.mock.calls[0]).toEqual(recordEvents.mock.calls[1]);
});
describe("V8 notification exclusions", () => {
  it("does not notify rejected or automatically scheduled runs", async () => {
    const f = fixture();
    f.run.pauseReason = "HUMAN_REJECTED";
    Object.assign(f.service.store.scoped(context).videoRun, {
      findMany: vi.fn(async () => [f.run]),
    });
    const db = {
      workspace: { findMany: vi.fn(async () => [{ id: context.workspaceId }]) },
      workspaceMembership: {
        findFirst: vi.fn(async (): Promise<{ userId: string; role: string } | null> => ({
          userId: context.userId,
          role: "OWNER",
        })),
      },
    };
    const recordEvents = vi.fn(async (events: readonly NotificationEventInput[]) => events.length);
    const runtime = new RunNotifications(db as unknown as Database, f.service, {
      recordEvents,
    } as unknown as NotificationsService);
    await runtime.tick();
    expect(recordEvents.mock.calls[0]?.[0]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "VIDEO_RUN_APPROVAL_REQUESTED" }),
      ]),
    );
    db.workspaceMembership.findFirst.mockResolvedValueOnce(null);
    await runtime.tick();
    expect(recordEvents).toHaveBeenCalledTimes(1);
  });
});
