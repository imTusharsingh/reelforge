import { expect, it, vi } from "vitest";
import { GeminiText, Interactions, ProviderFailure, ProviderHttp } from "@reelforge/ai-providers";
import { recoverTextDispatches } from "../usage-budget/text-dispatch-recovery.js";
import { OUTCOME_UNKNOWN } from "../usage-budget/run-admission-state.js";
import { runsFixture } from "./runs.fixture.js";
import { textFixture } from "./text-dispatch.fixture.js";
const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);

test.each([false, true])(
  "definitive late text rejection charges zero (owner settled: %s)",
  async (ownerSettled) => {
    const { t, step, accounts, paid } = await textFixture(fixture, true);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>(async () => {
      started.resolve();
      return response.promise;
    });
    const text = new GeminiText(
      new Interactions(new ProviderHttp("AIza" + "abc".repeat(12), "gemini", fetcher), {
        save: async (): Promise<never> => {
          throw new Error("Unexpected storage");
        },
      }),
      "fixture-text",
    );
    const dispatch = accounts.dispatchText(t.context, step, () =>
      text.complete(
        { prompt: "Fixture", jsonSchema: {}, parse: (value) => value },
        step.idempotencyKey,
      ),
    );
    const observed = expect(dispatch).rejects.toThrow("HTTP 401");
    await started.promise;
    try {
      const [termination] = await t.db.$queryRaw<{ terminated: boolean }[]>`
        SELECT pg_terminate_backend(pid,5000) AS terminated FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND classid::bigint = ((hashtextextended(${`sync-text:${step.id}`}, 0) >> 32) & 4294967295)
          AND objid::bigint = (hashtextextended(${`sync-text:${step.id}`}, 0) & 4294967295)
      `;
      expect(termination?.terminated).toBe(true);
      await recoverTextDispatches(t.store, t.context, t.usage);
      expect(
        await t.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } }),
      ).toMatchObject({ errorCode: OUTCOME_UNKNOWN });
      if (ownerSettled) await t.control.abandonTerminalText(t.context, step.runId, step.id);
    } finally {
      response.resolve(Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 }));
      await observed;
    }
    await paid.finalizeRejected(
      t.context,
      step,
      new ProviderFailure("REFUSAL", false, 0, {
        status: 401,
        code: "UNAUTHENTICATED",
      }),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const reservation = await t.db.usageReservation.findFirstOrThrow({
      where: { idempotencyKey: `m08:${step.idempotencyKey}` },
    });
    expect(reservation).toMatchObject(
      ownerSettled
        ? { status: "COMMITTED", committedMinor: 0n }
        : { status: "RELEASED", committedMinor: null },
    );
    expect(await t.db.budgetEnvelope.findFirst({ where: { runId: step.runId } })).toMatchObject({
      spentMinor: 0,
      reservedMinor: 0,
    });
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: step.id } })).toMatchObject({
      state: "FAILED",
      costMinor: 0,
      error: { code: "PROVIDER_UNAUTHENTICATED" },
    });
    expect(
      await t.db.runEvent.count({ where: { stepId: step.id, type: "text_rejection_reconciled" } }),
    ).toBe(ownerSettled ? 1 : 0);
  },
);
