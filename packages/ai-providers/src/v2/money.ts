import type { Money } from "./ports.js";
function integer(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Non-negative safe integer required");
  return BigInt(value);
}
function safe(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Money overflow");
  return result;
}
/** Provider duration precision is milliseconds; never round the per-second rate to cents. */
export function secondsCost(seconds: number, microUsdPerSecond: number): Money {
  const milliseconds = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || Math.abs(milliseconds / 1000 - seconds) > 1e-9)
    throw new Error("Duration must have at most millisecond precision");
  return {
    currency: "USD",
    microUsd: safe((integer(milliseconds) * integer(microUsdPerSecond) + 999n) / 1000n),
  };
}
export function reservationCents(money: Money): number {
  return safe((integer(money.microUsd) + 9999n) / 10000n);
}
export function ledgerUsd(money: Money): string {
  const amount = integer(money.microUsd);
  return `${amount / 1000000n}.${String(amount % 1000000n).padStart(6, "0")}`;
}
