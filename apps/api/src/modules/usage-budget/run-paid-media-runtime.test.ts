import { beforeEach, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { alignmentLanguage } from "../composition/alignment-language.js";
import type { Context, Run, Step } from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { UsageBudgetService } from "./usage-budget.service.js";
import { RunPaidCalls } from "./run-paid.js";

const ready = vi.hoisted(() => ({ assertLanguage: vi.fn(), readAdmission: vi.fn() }));
vi.mock("../composition/media-runtime.js", () => ({ mediaRuntimeGate: ready }));
vi.mock("./run-admission-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-admission-state.js")>()),
  readAdmission: ready.readAdmission,
}));

function fixture(language: string): {
  calls: RunPaidCalls;
  run: Run;
  step: Step;
  mutate: Mock;
  reserve: Mock;
  providerRequestWrite: Mock;
  rollback: MockInstance<RunPaidCalls["rollbackAdmission"]>;
  context: Context;
} {
  const run = {
    id: "run",
    inputSnapshot: { brief: { languages: { narration: language } } },
  } as unknown as Run;
  const step = { id: "step", runId: run.id } as Step;
  const mutate = vi.fn(async (_context, _run, _event, callback) => callback(null, run, {}));
  const reserve = vi.fn();
  const providerRequestWrite = vi.fn();
  const calls = new RunPaidCalls(
    { reserve } as unknown as UsageBudgetService,
    {
      mutate,
      db: { providerRequest: { updateMany: providerRequestWrite } },
    } as unknown as RunsStore,
  );
  return {
    calls,
    run,
    step,
    mutate,
    reserve,
    providerRequestWrite,
    rollback: vi.spyOn(calls, "rollbackAdmission").mockResolvedValue(),
    context: {} as Context,
  };
}

beforeEach(() => vi.resetAllMocks());

it("blocks before budget reservation or provider dispatch when local media is unavailable", async () => {
  ready.assertLanguage.mockImplementation(() => {
    throw new Error("Local media preflight failed");
  });
  const { calls, run, step, mutate, reserve, providerRequestWrite, rollback, context } =
    fixture("English");
  const provider = vi.fn();
  await expect(calls.reserve(context, run, step, 1)).rejects.toThrow("media preflight");
  expect(mutate).not.toHaveBeenCalled();
  await expect(calls.dispatch(context, step, provider)).rejects.toThrow("media preflight");
  expect(reserve).not.toHaveBeenCalled();
  expect(providerRequestWrite).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(rollback).toHaveBeenCalledWith(context, step);
});

it("rejects an unsupported pinned narration before reservation and rolls back only pending dispatch", async () => {
  ready.assertLanguage.mockImplementation((getLanguage: () => unknown) =>
    alignmentLanguage(getLanguage(), new Set(["eng", "ita"])),
  );
  const { calls, run, step, mutate, reserve, providerRequestWrite, rollback, context } =
    fixture("Spanish");
  const provider = vi.fn();
  const error = { response: { code: "NARRATION_LANGUAGE_UNSUPPORTED" } };
  await expect(calls.reserve(context, run, step, 1)).rejects.toMatchObject(error);
  expect(mutate).not.toHaveBeenCalled();
  await expect(calls.dispatch(context, step, provider)).rejects.toMatchObject(error);
  expect(reserve).not.toHaveBeenCalled();
  expect(providerRequestWrite).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(rollback).toHaveBeenCalledWith(context, step);

  // Receipt recovery is read-only and is not a second dispatch.
  ready.assertLanguage.mockClear();
  ready.readAdmission.mockResolvedValue({
    evidence: "dispatching",
    request: { responseMetadata: { providerJobId: "accepted-job" } },
  });
  await expect(calls.jobReceipt(context, step)).resolves.toBe("accepted-job");
  expect(ready.assertLanguage).not.toHaveBeenCalled();
});

it("lets supported pinned Italian reach the ledger boundary", async () => {
  ready.assertLanguage.mockImplementation((getLanguage: () => unknown) =>
    alignmentLanguage(getLanguage(), new Set(["eng", "ita"])),
  );
  const { calls, run, step, mutate, context } = fixture("Italian");
  mutate.mockRejectedValueOnce(new Error("Ledger boundary reached"));
  await expect(calls.reserve(context, run, step, 1)).rejects.toThrow("Ledger boundary reached");
  expect(mutate).toHaveBeenCalledOnce();
});
