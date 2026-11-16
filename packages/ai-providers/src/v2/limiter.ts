import { ProviderFailure } from "./http.js";
import type { Money } from "./ports.js";
export class ProviderLimiter {
  private active = 0;
  private blockedUntil = 0;
  private readonly calls: { at: number; microUsd: number; day: string; month: string }[] = [];
  public constructor(
    private readonly concurrency = 1,
    private readonly now: () => number = Date.now,
  ) {}
  /** Fail with a retry delay for the caller's delayed job; never sleep an HTTP request. */
  public async run<T>(
    estimate: Money,
    operation: () => Promise<T>,
    geminiTierOne = true,
  ): Promise<T> {
    const now = this.now();
    const pacific = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
    const month = pacific.slice(0, 7);
    while (this.calls.length && this.calls[0]!.month !== month) this.calls.shift();
    const minute = this.calls.filter((call) => call.at > now - 60000);
    const day = this.calls.filter((call) => call.day === pacific);
    const spend = this.calls
      .filter((call) => call.at > now - 600000)
      .reduce((sum, call) => sum + call.microUsd, 0);
    if (this.active >= this.concurrency || this.blockedUntil > now)
      throw new ProviderFailure("RATE_LIMIT", false, Math.max(1000, this.blockedUntil - now));
    if (
      geminiTierOne &&
      (minute.length >= 8 ||
        day.length >= 40 ||
        spend + estimate.microUsd > 10000000 ||
        this.calls.reduce((sum, call) => sum + call.microUsd, 0) + estimate.microUsd > 250000000)
    )
      throw new ProviderFailure("RATE_LIMIT", false, 60000);
    this.active++;
    const call = { at: now, microUsd: estimate.microUsd, day: pacific, month };
    this.calls.push(call);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderFailure && !error.dispatched)
        this.calls.splice(this.calls.indexOf(call), 1);
      if (error instanceof ProviderFailure && error.kind === "RATE_LIMIT")
        this.blockedUntil = now + error.retryAfterMs;
      throw error;
    } finally {
      this.active--;
    }
  }
}
