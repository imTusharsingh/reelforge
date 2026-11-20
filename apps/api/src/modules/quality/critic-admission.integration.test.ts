import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderFailure } from "@reelforge/ai-providers";
import { generating, runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Run, Step } from "../runs/runs.types.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { criticReservationCents, criticTextPort } from "./critic-text-port.js";

async function criticRun(t: Tenant): Promise<Run> {
  await generating(t);
  return t.db.videoRun.update({ where: { id: t.run.id }, data: { state: "CRITIC" } });
}
function critic(
  t: Tenant,
  run: Run,
): {
  accounts: MediaAccounts;
  complete: ReturnType<
    typeof vi.fn<() => Promise<{ output: number; providerJobId: string; usage: object }>>
  >;
  review: () => ReturnType<ReturnType<typeof criticTextPort>["complete"]>;
  steps: () => Promise<Step[]>;
} {
  const access = {
    runs: t.runs,
    paid: new RunPaidCalls(t.usage, t.store),
    artifacts: t.artifacts,
    boundary: new RunsBoundary({ check: async (): Promise<typeof t.stop> => t.stop }, t.runs),
  } as MediaAccess;
  const accounts = new MediaAccounts(access);
  const complete = vi.fn(async () => ({ output: 8, providerJobId: "critic-job", usage: {} }));
  const ports = { get: async () => ({ text: { complete } }) } as unknown as MediaPorts;
  const port = criticTextPort({ access, accounts, ports, context: t.context, run, attempt: 1 });
  const spec = {
    prompt: "review",
    jsonSchema: {},
    parse: (value: unknown): number => z.number().parse(value),
  };
  return {
    accounts,
    complete,
    review: () => port.complete(spec, "critic"),
    steps: (): Promise<Step[]> =>
      t.db.videoRunStep.findMany({
        where: { runId: run.id, key: "media:text:critic:1" },
        orderBy: { attempt: "asc" },
      }),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe.skipIf(!process.env.DATABASE_URL)("critic text admission recovery", () => {
  const fixture = runsFixture();
  it.each(["intent", "reserved"] as const)(
    "rolls back the %s at zero before retrying once",
    async (cut) => {
      vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
      const t = await fixture.tenant();
      const run = await criticRun(t);
      const c = critic(t, run);
      vi.spyOn(c.accounts, cut === "intent" ? "prepare" : "dispatchText").mockRejectedValueOnce(
        new Error("worker stopped"),
      );
      await expect(c.review()).rejects.toThrow("worker stopped");
      const [original] = await c.steps();
      const where = { workspaceId: run.workspaceId, correlationId: original!.id };
      expect(await t.db.providerRequest.count({ where })).toBe(cut === "intent" ? 0 : 1);
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: criticReservationCents(), spentMinor: 0 });
      expect(c.complete).not.toHaveBeenCalled();
      await expect(c.review()).resolves.toMatchObject({ output: 8 });
      await expect(c.review()).resolves.toMatchObject({ output: 8 });
      expect(c.complete).toHaveBeenCalledOnce();
      expect(await c.steps()).toMatchObject([
        { id: original!.id, state: "CANCELLED", output: { closedBy: "NOT_DISPATCHED" } },
        { attempt: 2, state: "SUCCEEDED" },
      ]);
      if (cut === "reserved") {
        const request = await t.db.providerRequest.findFirstOrThrow({ where });
        expect(request.errorCode).toBe("NOT_DISPATCHED");
        expect(request.actualCost?.toNumber()).toBe(0);
        expect(
          await t.db.usageReservation.findFirstOrThrow({
            where: { idempotencyKey: `m08:${original!.idempotencyKey}` },
          }),
        ).toMatchObject({ status: "RELEASED", committedMinor: null });
      } else expect(await t.db.providerRequest.count({ where })).toBe(0);
      expect(
        await t.db.runEvent.count({
          where: { runId: run.id, stepId: original!.id, type: "provider_dispatch" },
        }),
      ).toBe(0);
      expect(
        await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } }),
      ).toMatchObject({ reservedMinor: 0, spentMinor: criticReservationCents() });
      expect((await t.store.get(t.context, run.id)).pauseReason).toBeNull();
    },
  );

  it("holds an ambiguous critic replay with its original key and both claims", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    vi.spyOn(c.accounts, "dispatchText").mockRejectedValueOnce(new Error("worker stopped"));
    await expect(c.review()).rejects.toThrow("worker stopped");
    const [step] = await c.steps();
    const where = { workspaceId: run.workspaceId, correlationId: step!.id };
    await t.db.providerRequest.updateMany({
      where,
      data: { responseMetadata: { dispatched: false } },
    });
    await expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED");
    await expect(c.review()).rejects.toThrow("RECONCILE_REQUIRED");
    expect(c.complete).not.toHaveBeenCalled();
    expect(await c.steps()).toMatchObject([
      { idempotencyKey: step!.idempotencyKey, state: "RUNNING" },
    ]);
    expect(await t.db.providerRequest.findFirstOrThrow({ where })).toMatchObject({
      errorCode: "VIDEO_RUN_OUTCOME_UNKNOWN",
      actualCost: null,
    });
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "RESERVED",
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: criticReservationCents(),
      spentMinor: 0,
    });
    expect((await t.store.get(t.context, run.id)).pauseReason).toContain(step!.id);
  });

  it("finalizes a definitive INVALID_ARGUMENT rejection without operator action", async () => {
    vi.stubEnv("GEMINI_TEXT_MODEL", "critic-fixture");
    const t = await fixture.tenant();
    const run = await criticRun(t);
    const c = critic(t, run);
    const failure = new ProviderFailure("INVALID", false, 0, {
      status: 400,
      code: "INVALID_ARGUMENT",
    });
    c.complete.mockRejectedValueOnce(failure);
    await expect(c.review()).rejects.toBe(failure);
    await expect(c.review()).rejects.toThrow("Critic provider request was rejected");
    const [step] = await c.steps();
    expect(step).toMatchObject({
      state: "FAILED",
      costMinor: 0,
      error: { code: "PROVIDER_INVALID" },
    });
    const where = { workspaceId: run.workspaceId, correlationId: step!.id };
    const request = await t.db.providerRequest.findFirstOrThrow({ where });
    expect(request).toMatchObject({
      errorCode: "NOT_DISPATCHED",
      responseMetadata: { dispatched: false, costKnown: true },
    });
    expect(request.actualCost?.toNumber()).toBe(0);
    expect(await t.db.usageReservation.findFirstOrThrow({ where })).toMatchObject({
      status: "RELEASED",
      committedMinor: null,
    });
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 0,
    });
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "FAILED",
      pauseReason: "PROVIDER_INVALID",
    });
    expect(c.complete).toHaveBeenCalledOnce();
  });
});
