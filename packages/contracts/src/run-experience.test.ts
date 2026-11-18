import { describe, expect, it } from "vitest";
import { autonomyPolicy } from "./foundations.js";
import {
  criticGatesPass,
  criticReport,
  humanGatesPass,
  RunDecisionSchema,
} from "./run-experience.js";
const report = {
  recommendation: "APPROVE" as const,
  summary: "Ready",
  gates: {
    policy: true,
    rights: true,
    technical: true,
    budget: true,
    permission: true,
    score: true,
  },
};
describe("V8 gate evidence", () => {
  it("fails closed on absent, malformed or unknown evidence", () => {
    for (const value of [null, {}, { result: {} }, { ...report, extra: true }])
      expect(criticReport(value)).toBeNull();
    expect(criticGatesPass(null)).toBe(false);
    expect(humanGatesPass(null)).toBe(false);
    expect(criticReport({ result: report })).toEqual(report);
    expect(criticReport({ result: { report, criticPassed: true, packaging: {} } })).toEqual(report);
    expect(criticReport({ result: { report: { ...report, extra: true } } })).toBeNull();
  });
  it("requires every hard gate for humans and the score threshold for auto", () => {
    expect(criticGatesPass(report)).toBe(true);
    for (const gate of Object.keys(report.gates)) {
      const failed = { ...report, gates: { ...report.gates, [gate]: false } };
      expect(criticGatesPass(failed)).toBe(false);
      expect(humanGatesPass(failed)).toBe(gate === "score");
    }
    expect(criticGatesPass({ ...report, recommendation: "REJECT" })).toBe(false);
  });
  it("consumes V1 first-ten rules without changing L1/L2", () => {
    for (const approved of [0, 9, 10, 11]) {
      expect(autonomyPolicy("L1", approved).effective).toBe("L1");
      expect(autonomyPolicy("L2", approved).effective).toBe("L2");
      expect(autonomyPolicy("L3", approved).effective).toBe(approved < 10 ? "L2" : "L3");
      expect(autonomyPolicy("L2", approved).offerL3).toBe(approved >= 10);
    }
  });
  it("validates one-tap payloads strictly", () => {
    for (const decision of ["APPROVE", "REJECT"])
      expect(RunDecisionSchema.parse({ decision })).toEqual({ decision });
    expect(RunDecisionSchema.safeParse({ decision: "PUBLISH" }).success).toBe(false);
    expect(RunDecisionSchema.safeParse({ decision: "APPROVE", userId: "forged" }).success).toBe(
      false,
    );
  });
});
