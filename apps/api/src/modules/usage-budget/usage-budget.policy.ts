import { Injectable } from "@nestjs/common";
import type {
  BudgetPolicyInput,
  BudgetPolicyPort,
  BudgetPolicyResult,
} from "../orchestration/orchestration.types.js";
import { UsageBudgetService } from "./usage-budget.service.js";

/**
 * The real M16 BudgetPolicyPort adapter (ADR-017 item 4). No budget configured returns
 * NOT_CONFIGURED / BUDGET_POLICY_UNAVAILABLE, so scheduled runs stay blocked (fail closed) and
 * manual runs follow M16's rule. An exhausted budget returns BLOCKED / BUDGET_EXHAUSTED, which M16
 * enforces for both triggers. Errors propagate: the adapter never answers ALLOWED on failure.
 */
@Injectable()
export class UsageBudgetPolicy implements BudgetPolicyPort {
  public constructor(private readonly usage: UsageBudgetService) {}

  public async evaluate(input: BudgetPolicyInput): Promise<BudgetPolicyResult> {
    const result = await this.usage.evaluatePolicy(input.workspaceId, input.channelId);
    return { decision: result.decision, reason: result.reason };
  }
}
