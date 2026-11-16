import { describe, expect, it, vi } from "vitest";
import {
  ProviderFailure,
  secondsCost,
  ledgerUsd,
  type VideoGenPort,
  type ClipArtifact,
} from "@reelforge/ai-providers";
import { Prisma } from "@reelforge/database";
import type { Database } from "../identity/identity.types.js";
import type { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { ProviderLedger } from "./provider-ledger.js";
import { shot, catalog, artifact } from "./provider.fixture.js";

const omniRate = catalog[0]!.pricePerSecond["720p"]!;
const clipEstimate = secondsCost(shot.durationSeconds, omniRate);
function setup(): {
  ledger: ProviderLedger;
  db: {
    providerRequest: {
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  budgets: { reservePaidCall: ReturnType<typeof vi.fn>; finishPaidCall: ReturnType<typeof vi.fn> };
  port: VideoGenPort;
} {
  const db = {
    providerRequest: {
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({
        providerId: "gemini",
        estimatedCost: new Prisma.Decimal(ledgerUsd(clipEstimate)),
        responseMetadata: { reservationId: "reservation", estimateMinor: 56 },
      }),
    },
  };
  const budgets = {
    reservePaidCall: vi.fn().mockResolvedValue({
      workspaceId: shot.workspaceId,
      reservationId: "reservation",
      currency: "USD",
      estimateMinor: 56,
    }),
    finishPaidCall: vi.fn().mockResolvedValue(undefined),
  };
  const port: VideoGenPort = {
    capabilities: () => catalog[0]!,
    estimate: () => clipEstimate,
    submit: vi.fn().mockResolvedValue({ providerJobId: "job" }),
    poll: vi.fn(),
    fetch: vi.fn(),
  };
  return {
    ledger: new ProviderLedger(db as unknown as Database, budgets as unknown as UsageBudgetService),
    db,
    budgets,
    port,
  };
}
describe("M18 to M08 exact cost path", () => {
  it("reserves rounded cents before ledger intent and dispatch, then reconciles billed seconds exactly", async () => {
    const { ledger, db, budgets, port } = setup();
    expect(await ledger.submit(port, shot, shot.id, null)).toEqual({ providerJobId: "job" });
    expect(budgets.reservePaidCall).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: 0.56, correlationId: shot.id }),
    );
    expect(db.providerRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ estimatedCost: "0.556032", errorCode: "PENDING" }),
    });
    expect(budgets.reservePaidCall.mock.invocationCallOrder[0]).toBeLessThan(
      db.providerRequest.create.mock.invocationCallOrder[0]!,
    );
    expect(db.providerRequest.create.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(port.submit).mock.invocationCallOrder[0]!,
    );
    expect(port.submit).toHaveBeenCalledWith(shot, `m08:${shot.id}`);
    await ledger.finish(shot.workspaceId, shot.id, port, { ...artifact, billedSeconds: 7.5 });
    expect(db.providerRequest.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actualCost: "0.521280", status: "SUCCEEDED" }),
      }),
    );
    expect(budgets.finishPaidCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ reservationId: "reservation" }),
      { dispatched: true, actualCost: 0.52128, actualCurrency: "USD" },
    );
  });
  it("charges uncertain failures at estimate and releases only provably unsent calls", async () => {
    for (const dispatched of [true, false]) {
      const { ledger, db, budgets, port } = setup();
      vi.mocked(port.submit).mockRejectedValue(new ProviderFailure("OUTAGE", dispatched));
      await expect(ledger.submit(port, shot, shot.id, null)).rejects.toThrow();
      expect(db.providerRequest.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actualCost: dispatched ? "0.556032" : "0",
            errorCode: dispatched ? "UNCERTAIN" : "NOT_DISPATCHED",
          }),
        }),
      );
      expect(budgets.finishPaidCall).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dispatched, actualCost: dispatched ? 0.556032 : null }),
      );
    }
  });
  it("blocks paid replay and budget denial before fetch, retains estimates without usage", async () => {
    const { ledger, db, budgets, port } = setup();
    budgets.reservePaidCall.mockRejectedValueOnce(new Error("budget"));
    await expect(ledger.submit(port, shot, shot.id, null)).rejects.toThrow("budget");
    expect(port.submit).not.toHaveBeenCalled();
    db.providerRequest.create.mockRejectedValueOnce(new Error("unique"));
    await expect(ledger.submit(port, shot, shot.id, null)).rejects.toThrow("already recorded");
    expect(port.submit).not.toHaveBeenCalled();
    expect(budgets.finishPaidCall).toHaveBeenCalledWith(expect.anything(), {
      dispatched: false,
      actualCost: null,
    });
    await ledger.finish(shot.workspaceId, shot.id, port, {
      ...artifact,
      billedSeconds: null,
    } as ClipArtifact);
    expect(budgets.finishPaidCall).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ actualCost: 0.556032 }),
    );
    db.providerRequest.findUnique.mockResolvedValue(null);
    await expect(ledger.finish("other", shot.id, port, artifact)).rejects.toThrow("mismatch");
    db.providerRequest.findUnique.mockResolvedValue({
      providerId: "gemini",
      responseMetadata: null,
    });
    await expect(ledger.finish(shot.workspaceId, shot.id, port, artifact)).rejects.toThrow(
      "metadata",
    );
  });
});
