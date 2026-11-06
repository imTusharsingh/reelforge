import { describe, expect, it } from "vitest";
import { ProviderError, ProviderRegistry, SpendGuard } from "./index.js";

describe("provider safety contracts", () => {
  it("requires registered credentials and capabilities", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get("x", "y")).toThrow(ProviderError);
  });
  it("blocks a request that exceeds the daily budget", async () => {
    const guard = new SpendGuard(async () => 9);
    await expect(
      guard.preflight({ workspaceId: "w", dailyLimit: 10, currency: "USD" }, 2),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});
