import { ConflictException } from "@nestjs/common";
import type { BudgetEnvelope, ShotSpec } from "@reelforge/contracts";

export type Estimate = Pick<BudgetEnvelope, "baseEstimateMinor" | "reshootReserveMinor" | "route">;
export function clipEstimate(
  shots: readonly Pick<ShotSpec, "durationSeconds">[],
  fallback: boolean,
): number {
  const micros = shots.reduce(
    (sum, shot) =>
      sum + shot.durationSeconds * (fallback ? 140000 : 69504) + (fallback ? 10000 : 0),
    0,
  );
  return Math.ceil(micros / 10000);
}
export function runEstimate(
  shots: readonly Pick<ShotSpec, "durationSeconds">[],
  fallback = false,
): Estimate {
  const seconds = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const clips = clipEstimate(shots, fallback);
  const overhead = Math.ceil(
    ((3 + 2 * shots.length) * 33600 + 500000 + (seconds / 10) * 2250 + 80000) / 10000,
  );
  const baseEstimateMinor = clips + overhead;
  if (baseEstimateMinor > 800) throw new ConflictException("Run estimate exceeds $8");
  return {
    baseEstimateMinor,
    reshootReserveMinor: Math.min(Math.ceil(clips / 2), 800 - baseEstimateMinor),
    route: fallback ? "FALLBACK" : "PRIMARY",
  };
}
export function fallbackEstimate(
  envelope: Pick<BudgetEnvelope, "spentMinor" | "reservedMinor" | "reshootReserveMinor">,
  remaining: readonly Pick<ShotSpec, "durationSeconds">[],
  overheadRemaining = 0,
): Estimate {
  const baseEstimateMinor =
    envelope.spentMinor +
    envelope.reservedMinor +
    clipEstimate(remaining, true) +
    overheadRemaining;
  if (baseEstimateMinor > 800) throw new ConflictException("Fallback exceeds $8");
  const reserve =
    baseEstimateMinor + envelope.reshootReserveMinor <= 800 ? envelope.reshootReserveMinor : 0;
  return { baseEstimateMinor, reshootReserveMinor: reserve, route: "FALLBACK" };
}
export function envelopeRoom(
  envelope: Pick<
    BudgetEnvelope,
    "baseEstimateMinor" | "reshootReserveMinor" | "spentMinor" | "reservedMinor" | "hardCapMinor"
  >,
  amount: number,
): boolean {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid minor-unit amount");
  return (
    envelope.spentMinor + envelope.reservedMinor + amount <=
    Math.min(envelope.hardCapMinor, envelope.baseEstimateMinor + envelope.reshootReserveMinor)
  );
}
