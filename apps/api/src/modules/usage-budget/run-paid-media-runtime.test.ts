import { expect, it, vi } from "vitest";
import type { Context, Run, Step } from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { UsageBudgetService } from "./usage-budget.service.js";
import { RunPaidCalls } from "./run-paid.js";

const ready = vi.hoisted(() => ({ assertReady: vi.fn() }));
vi.mock("../composition/media-runtime.js", () => ({ mediaRuntimeGate: ready }));

it("blocks before budget reservation or provider dispatch when local media is unavailable", async () => {
  ready.assertReady.mockImplementation(() => {
    throw new Error("Local media preflight failed");
  });
  const mutate = vi.fn(async (_context, _run, _event, callback) => callback());
  const reserve = vi.fn();
  const providerRequestWrite = vi.fn();
  const calls = new RunPaidCalls(
    { reserve } as unknown as UsageBudgetService,
    {
      mutate,
      db: { providerRequest: { updateMany: providerRequestWrite } },
    } as unknown as RunsStore,
  );
  const rollback = vi.spyOn(calls, "rollbackAdmission").mockResolvedValue();
  const context = {} as Context;
  const run = { id: "run" } as Run;
  const step = { id: "step", runId: run.id } as Step;
  const provider = vi.fn();

  await expect(calls.reserve(context, run, step, 1)).rejects.toThrow("media preflight");
  expect(mutate).not.toHaveBeenCalled();
  await expect(calls.dispatch(context, step, provider)).rejects.toThrow("media preflight");
  expect(reserve).not.toHaveBeenCalled();
  expect(providerRequestWrite).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(rollback).toHaveBeenCalledWith(context, step);
});
