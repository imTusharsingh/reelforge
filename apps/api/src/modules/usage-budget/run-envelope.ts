import { ConflictException } from "@nestjs/common";
import { reservationCents } from "@reelforge/ai-providers";
import { clipMoney, overheadCents } from "../scene-media/media-prices.js";
import type { BudgetEnvelope, ShotSpec } from "@reelforge/contracts";

export type Estimate = Pick<BudgetEnvelope, "baseEstimateMinor" | "reshootReserveMinor" | "route">;
export function clipEstimate(
  shots: readonly (Pick<ShotSpec, "durationSeconds"> &
    Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>)[],
  fallback: boolean,
): number {
  return shots.reduce((sum, shot) => sum + reservationCents(clipMoney(shot, fallback)), 0);
}
export function runEstimate(
  shots: readonly (Pick<ShotSpec, "durationSeconds"> &
    Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>)[],
  fallback = false,
): Estimate {
  const clips = clipEstimate(shots, fallback);
  const overhead = overheadCents(shots);
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
  remaining: readonly (Pick<ShotSpec, "durationSeconds"> &
    Partial<Pick<ShotSpec, "references" | "firstFrameFrom">>)[],
  overheadRemaining = 0,
): Estimate {
  const baseEstimateMinor =
    envelope.spentMinor +
    envelope.reservedMinor +
    clipEstimate(remaining, true) +
    overheadRemaining;
  if (baseEstimateMinor > 800)
    throw new ConflictException({ code: "BUDGET_CAP", message: "Fallback exceeds $8" });
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
