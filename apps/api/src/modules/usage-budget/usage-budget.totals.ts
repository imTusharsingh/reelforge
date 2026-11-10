import { classifyCost, categorize, type LedgerRow } from "./usage-budget.ledger.js";
import { minorToNumber } from "./usage-budget.money.js";
import { USAGE_CATEGORIES, type UsageCategoryValue } from "./usage-budget.types.js";

type Bucket = {
  actual: bigint;
  estimated: bigint;
  reserved: bigint;
  committed: bigint;
  requests: number;
  unknownCost: number;
};

type CurrencyBucket = {
  adjustmentNet: bigint;
  categories: Map<UsageCategoryValue, Bucket>;
};

export type CategoryTotalsView = Readonly<{
  category: UsageCategoryValue;
  actualMinor: number;
  estimatedMinor: number;
  reservedMinor: number;
  committedMinor: number;
  totalMinor: number;
  ledgerRequests: number;
  unknownCostRequests: number;
}>;

export type CurrencyTotalsView = Readonly<{
  currency: string;
  totalMinor: number;
  actualMinor: number;
  estimatedMinor: number;
  reservedMinor: number;
  committedMinor: number;
  adjustmentNetMinor: number;
  byCategory: CategoryTotalsView[];
}>;

export type UsageTotalsView = Readonly<{
  currencies: CurrencyTotalsView[];
  /** Ledger calls whose cost is not known (failed without an actual cost). */
  unknownCostRequests: number;
  /** Ledger calls with a cost but no usable currency; never silently converted. */
  unpricedRequests: number;
}>;

export type ReservationLike = Readonly<{
  category: UsageCategoryValue;
  currency: string;
  amountMinor: bigint;
  committedMinor: bigint | null;
  status: string;
  expiresAt: Date;
}>;

export type AdjustmentLike = Readonly<{ kind: string; currency: string; amountMinor: bigint }>;

const empty = (): Bucket => ({
  actual: 0n,
  estimated: 0n,
  reserved: 0n,
  committed: 0n,
  requests: 0,
  unknownCost: 0,
});

/** Aggregates ledger rows, reservations and adjustments per currency and category. */
export class UsageTotals {
  private readonly currencies = new Map<string, CurrencyBucket>();
  private unknownCost = 0;
  private unpriced = 0;

  public constructor(private readonly now: Date) {}

  public addLedger(row: LedgerRow): this {
    const cost = classifyCost(row);
    if (cost.kind === "UNKNOWN") {
      this.unknownCost += 1;
      if (cost.currency !== null) {
        const bucket = this.bucket(cost.currency, categorize(row));
        bucket.requests += 1;
        bucket.unknownCost += 1;
      }
      return this;
    }
    if (cost.currency === null || cost.amountMinor === null) {
      this.unpriced += 1;
      return this;
    }
    const bucket = this.bucket(cost.currency, categorize(row));
    bucket.requests += 1;
    if (cost.kind === "ACTUAL") bucket.actual += cost.amountMinor;
    else bucket.estimated += cost.amountMinor;
    return this;
  }

  public addReservation(reservation: ReservationLike): this {
    const bucket = this.bucket(reservation.currency, reservation.category);
    if (reservation.status === "COMMITTED") bucket.committed += reservation.committedMinor ?? 0n;
    else if (reservation.status === "RESERVED" && reservation.expiresAt > this.now)
      bucket.reserved += reservation.amountMinor;
    return this;
  }

  public addAdjustment(adjustment: AdjustmentLike): this {
    const currency = this.currency(adjustment.currency);
    currency.adjustmentNet +=
      adjustment.kind === "DEBIT" ? adjustment.amountMinor : -adjustment.amountMinor;
    return this;
  }

  public view(): UsageTotalsView {
    const currencies = [...this.currencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, bucket]): CurrencyTotalsView => {
        const byCategory = USAGE_CATEGORIES.filter((category) =>
          bucket.categories.has(category),
        ).map((category): CategoryTotalsView => {
          const value = bucket.categories.get(category) ?? empty();
          return {
            category,
            actualMinor: minorToNumber(value.actual),
            estimatedMinor: minorToNumber(value.estimated),
            reservedMinor: minorToNumber(value.reserved),
            committedMinor: minorToNumber(value.committed),
            totalMinor: minorToNumber(
              value.actual + value.estimated + value.reserved + value.committed,
            ),
            ledgerRequests: value.requests,
            unknownCostRequests: value.unknownCost,
          };
        });
        const sum = (pick: (item: Bucket) => bigint): bigint =>
          [...bucket.categories.values()].reduce((total, item) => total + pick(item), 0n);
        const actual = sum((item) => item.actual);
        const estimated = sum((item) => item.estimated);
        const reserved = sum((item) => item.reserved);
        const committed = sum((item) => item.committed);
        return {
          currency,
          totalMinor: minorToNumber(
            actual + estimated + reserved + committed + bucket.adjustmentNet,
          ),
          actualMinor: minorToNumber(actual),
          estimatedMinor: minorToNumber(estimated),
          reservedMinor: minorToNumber(reserved),
          committedMinor: minorToNumber(committed),
          adjustmentNetMinor: minorToNumber(bucket.adjustmentNet),
          byCategory,
        };
      });
    return {
      currencies,
      unknownCostRequests: this.unknownCost,
      unpricedRequests: this.unpriced,
    };
  }

  private currency(currency: string): CurrencyBucket {
    let found = this.currencies.get(currency);
    if (!found) {
      found = { adjustmentNet: 0n, categories: new Map() };
      this.currencies.set(currency, found);
    }
    return found;
  }

  private bucket(currency: string, category: UsageCategoryValue): Bucket {
    const owner = this.currency(currency);
    let found = owner.categories.get(category);
    if (!found) {
      found = empty();
      owner.categories.set(category, found);
    }
    return found;
  }
}
