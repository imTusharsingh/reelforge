import { Prisma } from "@reelforge/database";

/** ISO 4217 currencies whose minor unit is not 2 digits. Everything else uses 2. */
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

export function minorUnitExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/**
 * Converts an M08 ledger decimal (major units, up to 8 fraction digits) to integer minor units,
 * rounding up so fractional provider costs are never under-counted against a budget.
 */
export function decimalToMinor(value: Prisma.Decimal | string | number, currency: string): bigint {
  const decimal = new Prisma.Decimal(value);
  const scaled = decimal.mul(new Prisma.Decimal(10).pow(minorUnitExponent(currency))).ceil();
  return BigInt(scaled.toFixed(0));
}

/** JSON-safe view of a bigint money amount. Amounts beyond 2^53 are refused, never rounded. */
export function minorToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError("Money amount exceeds the safe integer range");
  return Number(value);
}
