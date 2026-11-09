import type { SocialPlatform } from "@reelforge/contracts";

export const PUBLISHING_SCHEDULE_PORT = "PUBLISHING_SCHEDULE_PORT";
export const PUBLISHING_BUDGET_PORT = "PUBLISHING_BUDGET_PORT";

export type ScheduleCheck = Readonly<{ allowed: boolean; reason: string }>;
export type BudgetCheck = Readonly<{ allowed: boolean; reason: string }>;
export type BudgetReservation = Readonly<{ reservationId: string }>;
export type PublishingPolicyContext = Readonly<{
  workspaceId: string;
  channelId: string;
  scheduledAt: Date | null;
  platform: SocialPlatform;
  destinationId: string;
  idempotencyKey: string;
}>;

export interface PublishingSchedulePort {
  check(context: PublishingPolicyContext): Promise<ScheduleCheck>;
}

export interface PublishingBudgetPort {
  check(context: PublishingPolicyContext): Promise<BudgetCheck>;
  reserve(context: PublishingPolicyContext): Promise<BudgetReservation>;
  settle(reservation: BudgetReservation): Promise<void>;
  release(reservation: BudgetReservation): Promise<void>;
}

export class UnconfiguredPublishingSchedulePort implements PublishingSchedulePort {
  public async check(): Promise<ScheduleCheck> {
    return {
      allowed: false,
      reason: "Publishing schedule policy is not configured; M16 scheduler integration is pending.",
    };
  }
}

export class UnconfiguredPublishingBudgetPort implements PublishingBudgetPort {
  public async check(): Promise<BudgetCheck> {
    return {
      allowed: false,
      reason: "Publishing budget policy is not configured; M18 budget integration is pending.",
    };
  }

  public async reserve(): Promise<BudgetReservation> {
    throw new Error("Publishing budget policy is not configured");
  }

  public async settle(): Promise<void> {
    throw new Error("Publishing budget policy is not configured");
  }

  public async release(): Promise<void> {
    throw new Error("Publishing budget policy is not configured");
  }
}
