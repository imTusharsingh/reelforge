import { describe, expect, it } from "vitest";
import { clipEstimate, envelopeRoom, fallbackEstimate, runEstimate } from "./run-envelope.js";

describe("V3 budget estimates", () => {
  const shots = Array.from({ length: 6 }, () => ({ durationSeconds: 7.5 }));
  it("uses micro-USD precision and includes all nonclip costs", () => {
    const estimate = runEstimate(shots);
    expect(clipEstimate(shots, false)).toBe(318);
    expect(estimate.baseEstimateMinor).toBe(428);
    expect(estimate.reshootReserveMinor).toBe(159);
    const fallback = runEstimate(shots, true);
    expect(fallback.baseEstimateMinor).toBe(746);
    expect(fallback.baseEstimateMinor + fallback.reshootReserveMinor).toBeLessThanOrEqual(800);
    expect(() => runEstimate(Array.from({ length: 24 }, () => ({ durationSeconds: 7.5 })))).toThrow(
      "$8",
    );
  });
  it("drops fallback reserve when necessary and rejects unaffordable remaining work", () => {
    const envelope = { spentMinor: 0, reservedMinor: 0, reshootReserveMinor: 157 };
    expect(fallbackEstimate(envelope, shots, 110)).toEqual({
      baseEstimateMinor: 746,
      reshootReserveMinor: 0,
      route: "FALLBACK",
    });
    expect(fallbackEstimate(envelope, [], 50).reshootReserveMinor).toBe(157);
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
});
