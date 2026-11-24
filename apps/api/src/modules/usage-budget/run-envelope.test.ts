import { describe, expect, it } from "vitest";
import {
  assertChargeCeilingEnforced,
  envelopeRoom,
  fallbackEstimate,
  runEstimate,
} from "./run-envelope.js";
import { readReceiptBudget } from "./run-shot-receipt.js";

describe("V3 budget estimates", () => {
  const shots = Array.from({ length: 6 }, () => ({ durationSeconds: 7.5 }));
  it("uses micro-USD precision and includes all nonclip costs", () => {
    const estimate = runEstimate(shots);
    expect(estimate).toMatchObject({
      expectedSpendMinor: 456,
      receiptBufferMinor: 312,
      baseEstimateMinor: 768,
      reshootReserveMinor: 32,
    });
    expect(() => runEstimate(shots, true)).toThrow("$8");
    expect(() => runEstimate(Array.from({ length: 24 }, () => ({ durationSeconds: 7.5 })))).toThrow(
      "$8",
    );
  });
  it("requires each five-second shot's rounded buffer before allocating reshoot funds", () => {
    const plan = Array.from({ length: 6 }, () => ({ durationSeconds: 5 }));
    expect(() => runEstimate(plan, false, 766)).toThrow("pinned cap");
    expect(runEstimate(plan, false, 767)).toMatchObject({
      expectedSpendMinor: 347,
      receiptBufferMinor: 420,
      baseEstimateMinor: 767,
      reshootReserveMinor: 0,
    });
  });
  it("funds individually rounded mandatory calls and the first critic before reshoots", () => {
    const threeShots = Array.from({ length: 3 }, () => ({ durationSeconds: 10 }));
    expect(() => runEstimate(threeShots, false, 353, 51)).toThrow("pinned cap");
    expect(() => runEstimate(threeShots, false, 357, 51)).toThrow("pinned cap");
    expect(() => runEstimate(threeShots, false, 427, 51)).toThrow("pinned cap");
    expect(runEstimate(threeShots, false, 428, 51)).toMatchObject({
      expectedSpendMinor: 323,
      receiptBufferMinor: 105,
      baseEstimateMinor: 428,
      reshootReserveMinor: 0,
    });
    expect(runEstimate(threeShots, false, 440, 70).baseEstimateMinor).toBe(435);
  });
  it("drops fallback reserve when necessary and rejects maximum-duration exposure", () => {
    const envelope = { spentMinor: 700, reservedMinor: 0, reshootReserveMinor: 157 };
    expect(fallbackEstimate(envelope, [], 50)).toEqual({
      baseEstimateMinor: 750,
      reshootReserveMinor: 0,
      route: "FALLBACK",
    });
    expect(() => fallbackEstimate(envelope, shots, 110)).toThrow("Fallback exceeds the run cap");
    expect(() => fallbackEstimate({ ...envelope, spentMinor: 800 }, shots)).toThrow();
  });
  it("checks outstanding reservations and the envelope as well as the hard cap", () => {
    const budget = {
      baseEstimateMinor: 400,
      reshootReserveMinor: 200,
      hardCapMinor: 800,
      spentMinor: 500,
      reservedMinor: 50,
    };
    expect(envelopeRoom(budget, 50)).toBe(true);
    expect(envelopeRoom(budget, 51)).toBe(false);
    expect(envelopeRoom({ ...budget, baseEstimateMinor: 800 }, 251)).toBe(false);
    expect(() => envelopeRoom(budget, -1)).toThrow();
    expect(() => envelopeRoom(budget, 0.5)).toThrow();
  });
  it("preserves unmarked legacy admissions", () => {
    expect(
      readReceiptBudget({
        receiptBudget: { admittedMinor: 67, bufferMinor: 14, estimateMinor: 53 },
      }),
    ).toMatchObject({ admittedMinor: 67, bufferMinor: 14, estimateMinor: 53 });
    expect(readReceiptBudget(null)).toBeUndefined();
  });
  it("fails closed for providers without a per-call charge ceiling", () => {
    for (const providerId of ["gemini", "xai"]) {
      expect(() =>
        assertChargeCeilingEnforced({
          providerId,
          enforcesPerCallChargeCeiling: false,
        }),
      ).toThrow("cannot enforce a per-call charge ceiling");
    }
    expect(() =>
      assertChargeCeilingEnforced({
        providerId: "test",
        enforcesPerCallChargeCeiling: true,
      }),
    ).not.toThrow();
  });
});
