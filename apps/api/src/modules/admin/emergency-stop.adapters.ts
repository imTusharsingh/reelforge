import type {
  BudgetPolicyInput,
  BudgetPolicyPort,
  BudgetPolicyResult,
} from "../orchestration/orchestration.types.js";
import type {
  PublishingPolicyContext,
  PublishingSchedulePort,
  ScheduleCheck,
} from "../publishing/publishing.ports.js";
import { EMERGENCY_STOP_CODE, type EmergencyStopPort } from "./emergency-stop.types.js";

/**
 * Composes the emergency stop with the M16 budget gate (M19-T06). M16 already evaluates this port
 * before a manual run starts, before a scheduled slot creates a run, and before a scheduled run
 * resumes, so a stop blocks all three without changing the M16 state machine: manual start is a
 * 409, a scheduled slot is SKIPPED with reason EMERGENCY_STOP. Otherwise the M18 policy decides.
 */
export class EmergencyStopBudgetPolicy implements BudgetPolicyPort {
  public constructor(
    private readonly stop: EmergencyStopPort,
    private readonly inner: BudgetPolicyPort,
  ) {}

  public async evaluate(input: BudgetPolicyInput): Promise<BudgetPolicyResult> {
    const decision = await this.stop.check({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
    });
    if (decision.stopped) return { decision: "BLOCKED", reason: EMERGENCY_STOP_CODE };
    return this.inner.evaluate(input);
  }
}

/**
 * Composes the emergency stop with the M13 publishing schedule gate. M13 runs this check in
 * `preflight`, which `publishNow` and `retry` require to pass before any upload starts or resumes.
 * Reconcile does not use preflight, so reconciliation stays allowed.
 */
export class EmergencyStopPublishingSchedulePort implements PublishingSchedulePort {
  public constructor(
    private readonly stop: EmergencyStopPort,
    private readonly inner: PublishingSchedulePort,
  ) {}

  public async check(context: PublishingPolicyContext): Promise<ScheduleCheck> {
    const decision = await this.stop.check({
      workspaceId: context.workspaceId,
      channelId: context.channelId,
    });
    if (decision.stopped)
      return {
        allowed: false,
        reason: `${EMERGENCY_STOP_CODE}: emergency stop (${decision.scope ?? "UNKNOWN"}) is active${
          decision.reason ? `: ${decision.reason}` : ""
        }`,
      };
    return this.inner.check(context);
  }
}
