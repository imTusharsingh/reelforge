import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderFailure } from "@reelforge/ai-providers";
import { DiscoveryTextCalls } from "./text-calls.js";
import { context, channelId } from "./discovery.fixture.js";

function fixture(): {
  calls: DiscoveryTextCalls;
  db: { providerRequest: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } };
  budget: { reservePaidCall: ReturnType<typeof vi.fn>; finishPaidCall: ReturnType<typeof vi.fn> };
  text: { complete: ReturnType<typeof vi.fn> };
} {
  const db = {
      providerRequest: {
        create: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    budget = {
      reservePaidCall: vi.fn().mockResolvedValue(null),
      finishPaidCall: vi.fn().mockResolvedValue(undefined),
    },
    text = {
      complete: vi
        .fn()
        .mockResolvedValue({ output: ["idea"], providerJobId: "fake-job", usage: { tokens: 12 } }),
    };
  return { calls: new DiscoveryTextCalls(db as never, budget as never), db, budget, text };
}
const spec = {
  prompt: "Scout",
  jsonSchema: { type: "array" },
  parse: (value: unknown): unknown => value,
};
afterEach(() => vi.unstubAllEnvs());
describe("V10 paid grounded text boundary", () => {
  it("reserves budget and creates durable ledger intent before fake dispatch", async () => {
    vi.stubEnv("DISCOVERY_TEXT_ESTIMATE_USD", "0.02");
    const { calls, db, budget, text } = fixture();
    expect(await calls.complete(context, channelId, text as never, spec, "tick")).toEqual(["idea"]);
    expect(budget.reservePaidCall.mock.invocationCallOrder[0]).toBeLessThan(
      db.providerRequest.create.mock.invocationCallOrder[0]!,
    );
    expect(db.providerRequest.create.mock.invocationCallOrder[0]).toBeLessThan(
      text.complete.mock.invocationCallOrder[0]!,
    );
    expect(text.complete).toHaveBeenCalledWith(spec, "m08:tick");
    expect(budget.finishPaidCall).toHaveBeenCalledWith(null, {
      dispatched: true,
      actualCost: null,
    });
    expect(db.providerRequest.update.mock.calls[0]?.[0].data.responseMetadata).toMatchObject({
      providerJobId: "fake-job",
      costKnown: false,
    });
  });
  it("fails closed without a valid estimate or when reservation/ledger fails", async () => {
    const { calls, db, budget, text } = fixture();
    vi.stubEnv("DISCOVERY_TEXT_ESTIMATE_USD", "");
    await expect(calls.complete(context, channelId, text as never, spec, "key")).rejects.toThrow(
      "must be configured",
    );
    expect(text.complete).not.toHaveBeenCalled();
    vi.stubEnv("DISCOVERY_TEXT_ESTIMATE_USD", "0.02");
    db.providerRequest.create.mockRejectedValue(new Error("duplicate intent"));
    await expect(calls.complete(context, channelId, text as never, spec, "key")).rejects.toThrow(
      "duplicate intent",
    );
    expect(text.complete).not.toHaveBeenCalled();
    expect(budget.finishPaidCall).toHaveBeenCalledWith(null, {
      dispatched: false,
      actualCost: null,
    });
    budget.reservePaidCall.mockRejectedValue(new Error("budget exhausted"));
    await expect(calls.complete(context, channelId, text as never, spec, "key")).rejects.toThrow(
      "budget exhausted",
    );
  });
  it.each([
    new ProviderFailure("REFUSAL", true),
    new ProviderFailure("INVALID", false),
    new Error("timeout"),
  ])(
    "records uncertain, refused and not-dispatched errors without vendor fallback",
    async (error) => {
      vi.stubEnv("DISCOVERY_TEXT_ESTIMATE_USD", "0.02");
      const { calls, db, budget, text } = fixture();
      text.complete.mockRejectedValue(error);
      await expect(calls.complete(context, channelId, text as never, spec, "key")).rejects.toBe(
        error,
      );
      const dispatched = !(error instanceof ProviderFailure) || error.dispatched;
      expect(budget.finishPaidCall).toHaveBeenCalledWith(null, { dispatched, actualCost: null });
      expect(db.providerRequest.update.mock.calls[0]?.[0].data.status).toBe("FAILED");
      expect(text.complete).toHaveBeenCalledOnce();
    },
  );
});
