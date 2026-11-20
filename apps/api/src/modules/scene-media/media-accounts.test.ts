import { describe, expect, it, vi } from "vitest";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { ProviderFailure, type MediaJobPort } from "@reelforge/ai-providers";
import { BudgetExhaustedError } from "../usage-budget/usage-budget.types.js";
import type { Context, Run, Step } from "../runs/runs.types.js";
import type { MediaAccess } from "./media-access.js";
import { MediaAccounts } from "./media-accounts.js";
import { MediaJobs } from "./media-jobs.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
const context = { workspaceId: "workspace", userId: "owner", role: "OWNER" } as Context;
const run = { id: "run" } as Run;
function harness(): {
  state: {
    step: Step | null;
    reservedMinor: number;
    reservation: { id: string } | null;
    request: { id: string } | null;
  };
  db: { usageReservation: { findFirst: ReturnType<typeof vi.fn> } };
  paid: { reserve: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> };
  boundary: { check: ReturnType<typeof vi.fn> };
  accounts: MediaAccounts;
  port: MediaJobPort<object>;
  tick: () => ReturnType<MediaJobs["tick"]>;
} {
  const state = {
    step: null as Step | null,
    reservedMinor: 0,
    reservation: null as { id: string } | null,
    request: null as { id: string } | null,
  };
  const steps = {
    findFirst: vi.fn(async () => state.step),
    findFirstOrThrow: vi.fn(async () => {
      if (!state.step) throw new Error("Missing step");
      return state.step;
    }),
    findMany: vi.fn(async () => (state.step ? [state.step] : [])),
    create: vi.fn(async ({ data }: { data: Step }) => {
      state.step = { ...data, id: "step", providerJobId: null };
      return state.step;
    }),
    updateMany: vi.fn(async ({ data }: { data: Partial<Step> }) => {
      state.step = { ...state.step!, ...data };
      return { count: 1 };
    }),
  };
  const db = {
    videoRunStep: steps,
    budgetEnvelope: {
      findFirst: vi.fn(async () => ({
        id: "budget",
        reservedMinor: state.reservedMinor,
        spentMinor: 0,
        baseEstimateMinor: 500,
        reshootReserveMinor: 100,
        hardCapMinor: 800,
        revision: 0,
      })),
      updateMany: vi.fn(async ({ data }: { data: { reservedMinor: number } }) => {
        state.reservedMinor = data.reservedMinor;
        return { count: 1 };
      }),
    },
    usageReservation: { findFirst: vi.fn(async () => state.reservation) },
    providerRequest: { findFirst: vi.fn(async () => state.request), updateMany: vi.fn() },
  };
  const paid = {
    reserve: vi.fn(async () => {
      state.reservation = { id: "reservation" };
      state.request = { id: "request" };
    }),
    finish: vi.fn(),
    dispatch: async (
      _context: unknown,
      _step: unknown,
      call: () => Promise<unknown>,
    ): Promise<unknown> => call(),
  };
  const boundary = { check: vi.fn() };
  const access = {
    gate: vi.fn(),
    paid,
    boundary,
    runs: {
      store: {
        db,
        scoped: (): typeof db => db,
        get: async (): Promise<Run> => run,
        mutate: async (
          _context: unknown,
          _runId: string,
          _event: string,
          work: (value: typeof db, current: Run) => Promise<{ value: unknown; payload: unknown }>,
        ): Promise<{ value: unknown; payload: unknown; event: { payload: unknown } }> => {
          const result = await work(db, run);
          return { ...result, event: { payload: result.payload } };
        },
      },
    },
  } as unknown as MediaAccess;
  const accounts = new MediaAccounts(access);
  const port: MediaJobPort<object> = {
    submit: vi.fn().mockResolvedValue({ providerJobId: "job" }),
    poll: vi.fn().mockResolvedValue("running"),
    fetch: vi.fn(),
  };
  const jobs = new MediaJobs(access, accounts, {} as StoragePort);
  const tick = (): ReturnType<MediaJobs["tick"]> =>
    jobs.tick(context, run, "music", port, {}, 4, "model", "v2");
  return { state, db, paid, boundary, accounts, port, tick };
}
describe("V5 media preflight with fake ledgers and providers", () => {
  it.each([
    new BudgetExhaustedError({
      budgetId: "budget",
      period: "DAY",
      limitMinor: 1,
      consumedMinor: 0,
      requestedMinor: 4,
      currency: "USD",
    }),
    new ServiceUnavailableException("Budget policy unavailable"),
  ])(
    "closes a proven denied reservation atomically without settling a nonexistent paid call: %s",
    async (error) => {
      const h = harness();
      h.paid.reserve.mockRejectedValue(error);
      await expect(h.tick()).rejects.toBe(error);
      expect(h.state.step?.state).toBe("CANCELLED");
      expect(h.state.reservedMinor).toBe(0);
      expect(h.paid.finish).not.toHaveBeenCalled();
      await expect(h.tick()).rejects.toThrow("MEDIA_NOT_DISPATCHED");
      expect(h.paid.reserve).toHaveBeenCalledOnce();
      expect(h.port.submit).not.toHaveBeenCalled();
      expect(h.db.usageReservation.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: context.workspaceId, idempotencyKey: "m08:run:media:music:1" },
        select: { id: true },
      });
    },
  );
  it.each(["absent", "partial", "complete"])(
    "holds budget and reconciles by key after an ambiguous %s ledger write, including retries",
    async (outcome) => {
      const h = harness();
      h.paid.reserve.mockImplementation(async () => {
        if (outcome !== "absent") h.state.reservation = { id: "reservation" };
        if (outcome === "complete") h.state.request = { id: "request" };
        throw new Error("Reservation commit acknowledgement lost");
      });
      await expect(h.tick()).rejects.toThrow("RECONCILE_REQUIRED");
      expect(h.state.step?.output).toMatchObject({
        reconciliationRequired: {
          idempotencyKey: "m08:run:media:music:1",
          reservationId: h.state.reservation?.id ?? null,
          requestId: h.state.request?.id ?? null,
        },
      });
      expect(h.state.step?.state).toBe("RUNNING");
      expect(h.state.reservedMinor).toBe(4);
      await expect(h.tick()).rejects.toThrow("RECONCILE_REQUIRED");
      expect(h.db.usageReservation.findFirst).toHaveBeenCalledTimes(3);
      expect(h.paid.reserve).toHaveBeenCalledOnce();
      expect(h.paid.finish).not.toHaveBeenCalled();
      expect(h.port.submit).not.toHaveBeenCalled();
    },
  );
  it("does not refund a denial-looking error when a paid reservation already exists", async () => {
    const h = harness();
    h.paid.reserve.mockImplementation(async () => {
      h.state.reservation = { id: "reservation" };
      throw new ServiceUnavailableException("Budget policy unavailable");
    });
    await expect(h.tick()).rejects.toThrow("RECONCILE_REQUIRED");
    expect(h.state.reservedMinor).toBe(4);
    expect(h.paid.finish).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
  });
  it("settles known non-dispatch on a boundary failure, releases the envelope once, and rejects replay", async () => {
    const h = harness();
    h.boundary.check
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ConflictException("Emergency stop"));
    await expect(h.tick()).rejects.toThrow("Emergency stop");
    expect(h.paid.finish).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ id: "step" }),
      false,
      0,
    );
    expect(h.state.step?.state).toBe("CANCELLED");
    expect(h.state.reservedMinor).toBe(0);
    await h.accounts.cancelUndispatched(context, h.state.step!);
    expect(h.paid.finish).toHaveBeenCalledOnce();
    await expect(h.tick()).rejects.toThrow("MEDIA_NOT_DISPATCHED");
    expect(h.port.submit).not.toHaveBeenCalled();
  });
  it("retains held funds when non-dispatch settlement fails and reconciles on retry", async () => {
    const h = harness();
    h.boundary.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Stopped"));
    h.paid.finish.mockRejectedValue(new Error("Settlement unavailable"));
    await expect(h.tick()).rejects.toThrow("Settlement unavailable");
    expect(h.state.reservedMinor).toBe(4);
    expect(h.state.step?.state).toBe("RUNNING");
    await expect(h.tick()).rejects.toThrow("RECONCILE_REQUIRED");
    expect(h.paid.reserve).toHaveBeenCalledOnce();
    expect(h.port.submit).not.toHaveBeenCalled();
  });
  it("never resubmits or refunds when a provider may have dispatched", async () => {
    const h = harness();
    vi.mocked(h.port.submit).mockRejectedValue(new ProviderFailure("OUTAGE", true));
    await expect(h.tick()).rejects.toBeInstanceOf(ProviderFailure);
    await expect(h.tick()).rejects.toThrow("RECONCILE_REQUIRED");
    expect(h.state.reservedMinor).toBe(4);
    expect(h.paid.finish).not.toHaveBeenCalled();
    expect(h.port.submit).toHaveBeenCalledOnce();
  });
  it("fails closed when ledger reconciliation is unavailable", async () => {
    const h = harness();
    h.paid.reserve.mockRejectedValue(new Error("Unknown outcome"));
    h.db.usageReservation.findFirst.mockRejectedValue(new Error("Ledger unavailable"));
    await expect(h.tick()).rejects.toThrow("Ledger unavailable");
    expect(h.state.reservedMinor).toBe(4);
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.paid.finish).not.toHaveBeenCalled();
  });
  it("prevents a replayed claim from reaching paid reservation", async () => {
    const h = harness();
    await h.accounts.begin(context, run, "media:music", {}, 4, "model");
    await expect(h.accounts.begin(context, run, "media:music", {}, 4, "model")).rejects.toThrow(
      "already claimed",
    );
    expect(h.state.reservedMinor).toBe(4);
    expect(h.paid.reserve).not.toHaveBeenCalled();
  });
});
