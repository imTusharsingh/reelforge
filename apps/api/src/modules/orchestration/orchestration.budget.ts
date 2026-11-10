import type { BudgetPolicyPort, BudgetPolicyResult } from "./orchestration.types.js";

export class UnconfiguredBudgetPolicy implements BudgetPolicyPort {
  public evaluate(): Promise<BudgetPolicyResult> {
    return Promise.resolve({
      decision: "NOT_CONFIGURED",
      reason: "BUDGET_POLICY_UNAVAILABLE",
    });
  }
}

export class StaticBudgetPolicy implements BudgetPolicyPort {
  public constructor(
    private readonly decision: "ALLOWED" | "BLOCKED" | "NOT_CONFIGURED",
    private readonly reason: string | null = null,
  ) {}

  public evaluate(): Promise<BudgetPolicyResult> {
    return Promise.resolve({ decision: this.decision, reason: this.reason });
  }
}
