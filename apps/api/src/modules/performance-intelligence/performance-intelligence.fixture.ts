import { ConflictException } from "@nestjs/common";
import { vi, type Mock } from "vitest";
import type { UsageBudgetService } from "../usage-budget/usage-budget.service.js";

export function paidUsage(): {
  reservePaidCall: Mock<UsageBudgetService["reservePaidCall"]>;
  finishPaidCall: Mock<UsageBudgetService["finishPaidCall"]>;
} {
  const reservations = new Set<string>();
  return {
    reservePaidCall: vi.fn<UsageBudgetService["reservePaidCall"]>(
      async ({ workspaceId, correlationId }) => {
        if (reservations.has(correlationId))
          throw new ConflictException({ code: "PAID_CALL_REPLAYED" });
        reservations.add(correlationId);
        return { workspaceId, reservationId: correlationId, currency: "USD", estimateMinor: 1 };
      },
    ),
    finishPaidCall: vi.fn<UsageBudgetService["finishPaidCall"]>().mockResolvedValue(undefined),
  };
}
