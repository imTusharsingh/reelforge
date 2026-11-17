import { describe, expect, it } from "vitest";
import { nextPublishingSlot, pacificQuotaDay } from "./automation-cadence.js";
describe("V9 cadence and Pacific insert bucket", () => {
  const cadence = { shortsPerDay: 1, localTime: "18:00", timezone: "Asia/Kolkata" };
  it("chooses the next free slot and respects existing calendar posts", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    expect(nextPublishingSlot(cadence, now, []).toISOString()).toBe("2026-11-17T12:30:00.000Z");
    expect(nextPublishingSlot(cadence, now, [new Date("2026-11-17T12:30:00Z")]).toISOString()).toBe(
      "2026-11-18T12:30:00.000Z",
    );
  });
  it("moves a spring gap to the first valid local minute and uses only one fold occurrence", () => {
    expect(
      nextPublishingSlot(
        { ...cadence, timezone: "America/New_York", localTime: "02:30" },
        new Date("2027-03-14T00:00:00Z"),
        [],
      ).toISOString(),
    ).toBe("2027-03-14T07:00:00.000Z");
    const fold = { ...cadence, timezone: "America/New_York", localTime: "01:30" };
    expect(nextPublishingSlot(fold, new Date("2026-11-01T00:00:00Z"), []).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(nextPublishingSlot(fold, new Date("2026-11-01T06:00:00Z"), []).toISOString()).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });
  it("resets at midnight Pacific across DST and rejects invalid cadences", () => {
    expect(pacificQuotaDay(new Date("2026-11-17T07:59:59Z"))).toBe("2026-11-16");
    expect(pacificQuotaDay(new Date("2026-11-17T08:00:00Z"))).toBe("2026-11-17");
    expect(pacificQuotaDay(new Date("2027-07-17T07:00:00Z"))).toBe("2027-07-17");
    expect(() => nextPublishingSlot({ ...cadence, timezone: "invalid" }, new Date(), [])).toThrow();
  });
});
