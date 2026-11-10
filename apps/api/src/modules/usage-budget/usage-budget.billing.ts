import { BillingNotConfiguredError } from "./usage-budget.types.js";

/**
 * M18-T06 extension point. Subscription and payment collection are out of scope for v1: there is
 * no adapter and no payment dependency. A future block binds a real provider behind this port.
 */
export interface BillingProviderPort {
  readonly status: "NOT_CONFIGURED" | "CONFIGURED";
  /** Creates or returns the billing customer for a workspace. */
  ensureCustomer(
    input: Readonly<{ workspaceId: string; correlationId: string }>,
  ): Promise<Readonly<{ customerRef: string }>>;
  /** Reports metered usage (minor units) for a closed period. Never called in v1. */
  reportUsage(
    input: Readonly<{
      workspaceId: string;
      periodKey: string;
      currency: string;
      amountMinor: number;
      idempotencyKey: string;
    }>,
  ): Promise<Readonly<{ reportRef: string }>>;
}

export class NotConfiguredBillingProvider implements BillingProviderPort {
  public readonly status = "NOT_CONFIGURED" as const;

  public ensureCustomer(): Promise<never> {
    return Promise.reject(new BillingNotConfiguredError());
  }

  public reportUsage(): Promise<never> {
    return Promise.reject(new BillingNotConfiguredError());
  }
}
