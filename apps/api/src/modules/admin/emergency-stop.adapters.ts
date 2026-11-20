import type {
  PublishingPolicyContext,
  PublishingSchedulePort,
  ScheduleCheck,
} from "../publishing/publishing.ports.js";
import { EMERGENCY_STOP_CODE, type EmergencyStopPort } from "./emergency-stop.types.js";

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
