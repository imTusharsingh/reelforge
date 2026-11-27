import { PLANNING_MANIFEST_KEY } from "../runs/run-outcomes.js";
import { beforeEach, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { alignmentLanguage } from "../composition/alignment-language.js";
import type { Context, Run, Step } from "../runs/runs.types.js";
import type { RunsStore } from "../runs/runs.store.js";
import type { UsageBudgetService } from "./usage-budget.service.js";
import { RunPaidCalls } from "./run-paid.js";

const ready = vi.hoisted(() => ({
  prepareLanguage: vi.fn(),
  assertFreshLanguage: vi.fn(),
  readAdmission: vi.fn(),
}));
vi.mock("../composition/media-runtime.js", () => ({ mediaRuntimeGate: ready }));
vi.mock("./run-admission-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-admission-state.js")>()),
  readAdmission: ready.readAdmission,
}));

function fixture(
  language: string,
  pace = 1,
  saved?: { output: unknown; target: number; actual?: number },
): {
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
    inputSnapshot: {
      brief: {
        languages: { narration: language },
        narratorVoice: { pace },
        targetDurationSeconds: saved?.target ?? 30,
      },
    },
  } as unknown as Run;
  const step = { id: "step", runId: run.id, state: "RUNNING", key: "shot-0" } as Step;
  const mutate = vi.fn(async (_context, _run, _event, callback) => callback(scoped, run, {}));
  const scoped = {
    videoRunStep: {
      findMany: vi.fn().mockResolvedValue(
        saved
          ? [
              {
                key: PLANNING_MANIFEST_KEY,
                state: "SUCCEEDED",
                attempt: 1,
                output: saved.output,
              },
            ]
          : [],
      ),
      findFirstOrThrow: vi.fn().mockImplementation(async () => step),
    },
    shotSpec: {
      findMany: vi
        .fn()
        .mockResolvedValue(saved?.actual ? [{ document: { durationSeconds: saved.actual } }] : []),
    },
  };
  const reserve = vi.fn();
  const providerRequestWrite = vi.fn();
  const calls = new RunPaidCalls(
    { reserve } as unknown as UsageBudgetService,
    {
      mutate,
      get: async () => run,
      scoped: () => scoped,
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
  ready.prepareLanguage.mockRejectedValue(new Error("Local media preflight failed"));
  const { calls, run, step, mutate, reserve, providerRequestWrite, rollback, context } =
    fixture("English");
  const provider = vi.fn();
  await expect(calls.reserve(context, run, step, 1)).rejects.toThrow("media preflight");
  expect(mutate).not.toHaveBeenCalled();
  await expect(calls.dispatch(context, step, provider)).rejects.toThrow("media preflight");
  expect(mutate).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  expect(providerRequestWrite).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(rollback).toHaveBeenCalledWith(context, step);
});

it("rejects an unsupported pinned narration before reservation and rolls back only pending dispatch", async () => {
  ready.prepareLanguage.mockImplementation(async (getLanguage: () => unknown) =>
    alignmentLanguage(await getLanguage(), new Set(["eng", "ita"])),
  );
  const { calls, run, step, mutate, reserve, providerRequestWrite, rollback, context } =
    fixture("Spanish");
  const provider = vi.fn();
  const error = { response: { code: "NARRATION_LANGUAGE_UNSUPPORTED" } };
  await expect(calls.reserve(context, run, step, 1)).rejects.toMatchObject(error);
  expect(mutate).not.toHaveBeenCalled();
  await expect(calls.dispatch(context, step, provider)).rejects.toMatchObject(error);
  expect(mutate).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  expect(providerRequestWrite).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(rollback).toHaveBeenCalledWith(context, step);

  // Receipt recovery is read-only and is not a second dispatch.
  ready.prepareLanguage.mockClear();
  ready.readAdmission.mockResolvedValue({
    evidence: "dispatching",
    request: { responseMetadata: { providerJobId: "accepted-job" } },
  });
  await expect(calls.jobReceipt(context, step)).resolves.toBe("accepted-job");
  expect(ready.prepareLanguage).not.toHaveBeenCalled();
});

it("lets supported pinned Italian reach the ledger boundary", async () => {
  ready.prepareLanguage.mockImplementation(async (getLanguage: () => unknown) =>
    alignmentLanguage(await getLanguage(), new Set(["eng", "ita"])),
  );
  const { calls, run, step, mutate, context } = fixture("Italian");
  mutate.mockRejectedValueOnce(new Error("Ledger boundary reached"));
  await expect(calls.reserve(context, run, step, 1)).rejects.toThrow("Ledger boundary reached");
  expect(mutate).toHaveBeenCalledOnce();
});

it("passes the out-of-transaction proof to the pinned guard during reservation", async () => {
  const marker = { fixture: "fresh" };
  const { calls, run, step, mutate, context, reserve } = fixture("Italian");
  ready.prepareLanguage.mockResolvedValue(marker);
  ready.assertFreshLanguage.mockImplementation((getLanguage: () => unknown, proof: unknown) => {
    expect(getLanguage()).toBe("Italian");
    expect(proof).toBe(marker);
    throw new Error("Ledger boundary reached");
  });
  await expect(calls.reserve(context, run, step, 1)).rejects.toThrow("Ledger boundary reached");
  expect(ready.prepareLanguage.mock.invocationCallOrder[0]).toBeLessThan(
    mutate.mock.invocationCallOrder[0]!,
  );
  expect(mutate.mock.invocationCallOrder[0]).toBeLessThan(
    ready.assertFreshLanguage.mock.invocationCallOrder[0]!,
  );
  expect(reserve).not.toHaveBeenCalled();
});

it("blocks reservation and dispatch for legacy pace while allowing receipt recovery", async () => {
  const { calls, run, step, mutate, reserve, context, rollback } = fixture("English", 3);
  const provider = vi.fn();
  const error = { response: { code: "NARRATION_PACE_UNSUPPORTED" } };
  await expect(calls.reserve(context, run, step, 1)).rejects.toMatchObject(error);
  await expect(calls.dispatch(context, step, provider)).rejects.toMatchObject(error);
  expect(mutate).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
  expect(rollback).toHaveBeenCalledWith(context, step);
  ready.readAdmission.mockResolvedValue({
    evidence: "dispatching",
    request: { responseMetadata: { providerJobId: "accepted-job" } },
  });
  await expect(calls.jobReceipt(context, step)).resolves.toBe("accepted-job");
  expect(ready.prepareLanguage).not.toHaveBeenCalled();
});

it.each([
  [30, 31, 31, false],
  [31, 31, 30, false],
  [31, 30, undefined, false],
  [31, undefined, undefined, true],
] as const)(
  "blocks new charges for target %s and shot totals %s/%s (malformed: %s), but keeps the receipt",
  async (target, durationSeconds, actual, malformed) => {
    const line = (n: number): string => Array<string>(n).fill("planet").join(" ");
    const script = {
      hook: line(4),
      beats: [line(26), line(26), line(26)],
      payoff: line(4),
      cta: line(4),
      language: "English",
      wordCount: 90,
    };
    const { calls, run, step, context, reserve, providerRequestWrite } = fixture("English", 1, {
      output: { script, manifest: { shots: [{ durationSeconds }] } },
      target,
      ...(actual ? { actual } : {}),
    });
    const submit = vi.fn();
    ready.readAdmission.mockResolvedValue({
      evidence: "pending",
      reservation: { status: "RESERVED", expiresAt: new Date(Date.now() + 60000) },
      request: { responseMetadata: { providerJobId: "already-submitted" } },
    });
    const error = {
      response: malformed
        ? {
            code: "SAVED_CAPTION_PLAN_UNUSABLE",
            detail: "MALFORMED_PLAN",
            message:
              "The saved plan is invalid and its captions could not be validated. Start a new Short.",
          }
        : {
            code: "SAVED_CAPTION_PLAN_UNUSABLE",
            detail: "CAPTIONS_TOO_LONG",
            message: "Saved captions cannot fit. Start a new Short with shorter narration.",
          },
    };
    await expect(calls.reserve(context, run, step, 1)).rejects.toMatchObject(error);
    await expect(calls.dispatch(context, step, submit)).rejects.toMatchObject(error);
    expect(reserve).not.toHaveBeenCalled();
    expect(providerRequestWrite).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    ready.readAdmission.mockResolvedValue({
      evidence: "dispatching",
      request: { responseMetadata: { providerJobId: "already-submitted" } },
    });
    await expect(calls.jobReceipt(context, step)).resolves.toBe("already-submitted");
  },
);
