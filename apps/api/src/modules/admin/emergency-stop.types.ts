import { ConflictException } from "@nestjs/common";

/** Injection token for the emergency-stop check used by M16, M18, and M13 adapters (M19-T06). */
export const EMERGENCY_STOP_PORT = "EMERGENCY_STOP_PORT";

export type EmergencyStopScopeValue = "GLOBAL" | "WORKSPACE" | "CHANNEL";

export type EmergencyStopDecision = Readonly<{
  stopped: boolean;
  scope: EmergencyStopScopeValue | null;
  reason: string | null;
}>;

export type EmergencyStopCheckInput = Readonly<{
  workspaceId: string;
  channelId?: string | null;
}>;

export interface EmergencyStopPort {
  /** Whether new external side effects are stopped for this workspace/channel. Never cached. */
  check(input: EmergencyStopCheckInput): Promise<EmergencyStopDecision>;
}

export const EMERGENCY_STOP_CODE = "EMERGENCY_STOP";

/** 409 with `code: EMERGENCY_STOP`; thrown before any provider/platform call is made. */
export class EmergencyStopError extends ConflictException {
  public readonly code = EMERGENCY_STOP_CODE;

  public constructor(decision: EmergencyStopDecision, action: string) {
    super({
      code: EMERGENCY_STOP_CODE,
      scope: decision.scope,
      message: `Emergency stop (${decision.scope ?? "UNKNOWN"}) is active; ${action} was not started${
        decision.reason ? `: ${decision.reason}` : ""
      }`,
    });
  }
}

export const NOT_STOPPED: EmergencyStopDecision = { stopped: false, scope: null, reason: null };
