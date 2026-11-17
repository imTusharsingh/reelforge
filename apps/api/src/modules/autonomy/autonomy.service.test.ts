import { describe, expect, it } from "vitest";
import { context, fixture, report } from "./autonomy.fixture.js";
describe("V8 durable decisions on fake V3 store", () => {
  it.each(["APPROVE", "REJECT"] as const)(
    "records a one-tap %s exactly once, including retry",
    async (decision) => {
      const f = fixture();
      await f.service.decide(context, f.run.id, decision);
      await f.service.decide(context, f.run.id, decision);
      expect(f.db.events).toHaveLength(1);
      expect(f.db.events[0]?.payload).toMatchObject({
        decision,
        criticAgreed: decision === "APPROVE",
        actorId: context.userId,
      });
      expect(f.run.state).toBe(decision === "APPROVE" ? "SCHEDULED" : "AWAITING_APPROVAL");
      if (decision === "REJECT") expect(f.run.pauseReason).toBe("HUMAN_REJECTED");
      await expect(
        f.service.decide(context, f.run.id, decision === "APPROVE" ? "REJECT" : "APPROVE"),
      ).rejects.toThrow("already decided");
    },
  );
  it("blocks viewer writes, emergency stops, stale state and missing gates", async () => {
    const f = fixture();
    await expect(
      f.service.decide({ ...context, role: "VIEWER" }, f.run.id, "APPROVE"),
    ).rejects.toThrow("Editor");
    f.stop.check.mockResolvedValueOnce({ stopped: true });
    await expect(f.service.decide(context, f.run.id, "APPROVE")).rejects.toThrow("Emergency");
    f.run.state = "GENERATING";
    await expect(f.service.decide(context, f.run.id, "APPROVE")).rejects.toThrow("No final");
    f.run.state = "AWAITING_APPROVAL";
    f.db.videoRunStep.findFirst.mockResolvedValueOnce(null);
    await expect(f.service.decide(context, f.run.id, "APPROVE")).rejects.toThrow("hard gates");
    f.run.pauseReason = "RECONCILE_REQUIRED";
    await expect(f.service.decide(context, f.run.id, "APPROVE")).rejects.toThrow(
      "unresolved pause",
    );
    expect(f.db.events).toHaveLength(0);
  });
  it("blocks L3 before ten, honors L1/L2 and requires planning-time explicit selection", async () => {
    const f = fixture();
    f.run.state = "PLANNING";
    await expect(f.service.select(context, f.run.id, "L3")).rejects.toThrow("ten");
    for (const level of ["L1", "L2"] as const) {
      await f.service.select(context, f.run.id, level);
      expect(f.run.effectiveAutonomy).toBe(level);
    }
    f.run.approvedShortsAtStart = 10;
    await f.service.select(context, f.run.id, "L3");
    expect(f.run.effectiveAutonomy).toBe("L3");
    f.run.state = "SCRIPTING";
    await expect(f.service.select(context, f.run.id, "L2")).rejects.toThrow("before planning");
  });
  it("offers L3 at ten approved Shorts with 8/10 agreement but never enables it", async () => {
    const f = fixture();
    f.db.runEvent.count.mockResolvedValue(10);
    f.db.runEvent.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ payload: { criticAgreed: i < 8 } })),
    );
    expect(await f.service.status(context, f.run)).toMatchObject({
      approvedShorts: 10,
      offerL3: true,
      agreements: 8,
      samples: 10,
      recommended: true,
    });
    expect(f.run.effectiveAutonomy).toBe("L2");
    f.db.runEvent.findMany.mockResolvedValue([{ payload: {} }, { payload: null }]);
    expect(await f.service.status(context, f.run)).toMatchObject({
      samples: 0,
      recommended: false,
    });
    expect(f.db.runEvent.count).toHaveBeenCalledWith({
      where: { type: "approved", run: { channelId: f.run.channelId } },
    });
  });
  it("sends L3 gate failure to the L2 inbox, fails closed on missing evidence", async () => {
    for (const output of [
      null,
      { result: { ...report, gates: { ...report.gates, score: false } } },
    ]) {
      const f = fixture();
      f.run.effectiveAutonomy = "L3";
      f.run.approvedShortsAtStart = 10;
      f.db.videoRunStep.findFirst.mockResolvedValue({ output });
      await f.service.settle(context, f.run);
      expect(f.run.effectiveAutonomy).toBe("L2");
      expect(f.run.state).toBe("AWAITING_APPROVAL");
      expect(f.db.events[0]?.type).toBe("autonomy_fallback");
    }
  });
  it("allows eligible L3 only with all gates; ordinary L2 waits for a tap", async () => {
    const f = fixture();
    await f.service.settle(context, f.run);
    expect(f.db.events).toHaveLength(0);
    f.run.effectiveAutonomy = "L3";
    f.run.approvedShortsAtStart = 10;
    await f.service.settle(context, f.run);
    expect(f.run.state).toBe("SCHEDULED");
    expect(f.db.events[0]?.type).toBe("auto_approved");
  });
});
