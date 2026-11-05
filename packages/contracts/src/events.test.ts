import { describe, expect, it } from "vitest";
import { parseRegisteredEvent } from "./events.js";

const validEvent = {
  eventId: "d92c8b44-2cf3-4e87-a4fc-9488f4bc6be1",
  eventType: "PostPublished",
  eventVersion: 1,
  occurredAt: "2026-11-05T00:00:00Z",
  workspaceId: "a71342b7-68f7-440b-884b-36f888d96019",
  correlationId: "e19db234-961e-4c32-83f4-7d9b82c0a335",
  idempotencyKey: "workspace:publish:post-1",
  aggregateType: "Post",
  aggregateId: "da48eaf2-dcd5-443f-8ff3-6e706d24000e",
  payload: {
    postId: "da48eaf2-dcd5-443f-8ff3-6e706d24000e",
    platform: "youtube",
    platformPostId: "remote-id",
  },
};

describe("registered event contracts", () => {
  it("parses a registered event", () => {
    expect(parseRegisteredEvent(validEvent).eventType).toBe("PostPublished");
  });

  it("rejects an unknown event type", () => {
    expect(() => parseRegisteredEvent({ ...validEvent, eventType: "Unknown" })).toThrow("Unregistered event type");
  });
});
