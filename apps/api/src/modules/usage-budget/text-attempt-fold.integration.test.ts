import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { runtimeFixture } from "../runs/text-attempt-runtime.fixture.js";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Step } from "../runs/runs.types.js";
import { appendTextEvidence, lockTextAttempt } from "./text-attempt-store.js";
import { foldTextAttempt } from "./text-attempt-fold.js";

async function newAttempt(t: Tenant): Promise<Step> {
  return t.db.videoRunStep.create({
    data: {
      workspaceId: t.run.workspaceId,
      runId: t.run.id,
      key: "media:text:scriptwriter",
      idempotencyKey: randomUUID(),
      state: "RUNNING",
      input: {},
      costMinor: 7,
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)("append-only text accounting", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());

  it("serializes exact evidence replay under the run and attempt locks", async () => {
    const t = await fixture.tenant();
    const attempt = await newAttempt(t);
    const prepared = {
      eventKey: "prepared",
      kind: "PREPARED" as const,
      data: { dispatchKey: attempt.idempotencyKey, modelId: "fixture", estimateMinor: 7 },
    };
    const firstInserted = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const first = t.store.mutate(t.context, t.run.id, "text_prepared", async (_db, _run, tx) => {
      const locked = await lockTextAttempt(tx, t.context.workspaceId, attempt.id);
      const receipt = await appendTextEvidence(tx, locked, prepared);
      await foldTextAttempt(tx, t.context, attempt.id);
      firstInserted.resolve();
      await secondEntered.promise;
      return { value: receipt, payload: {}, stepId: attempt.id };
    });
    await firstInserted.promise;
    const second = t.db.$transaction(async (tx) => {
      secondEntered.resolve();
      const locked = await lockTextAttempt(tx, t.context.workspaceId, attempt.id);
      return appendTextEvidence(tx, locked, prepared);
    });
    await expect(first).resolves.toMatchObject({ value: { inserted: true, sequence: 1 } });
    await expect(second).resolves.toEqual({ inserted: false, sequence: 1 });
    const events = await t.store.events(t.context, t.run.id, 0);
    expect(events.map((event) => event.type)).toEqual([
      "created",
      "text_prepared",
      "text_attempt_folded",
    ]);
    const changed = t.db.$transaction(async (tx) => {
      const locked = await lockTextAttempt(tx, t.context.workspaceId, attempt.id);
      return appendTextEvidence(tx, locked, {
        ...prepared,
        data: { ...prepared.data, estimateMinor: 8 },
      });
    });
    await expect(changed).rejects.toThrow("Contradictory");
    await expect(
      t.db.$transaction((tx) => lockTextAttempt(tx, randomUUID(), attempt.id)),
    ).rejects.toThrow("Paid text attempt not found");
  });

  it.each([
    { status: "PLANNING", pauseReason: null, failsRun: true },
    { status: "CANCELED", pauseReason: null, failsRun: false },
    { status: "PLANNING", pauseReason: "CANCEL_REQUESTED", failsRun: false },
    { status: "PLANNING", pauseReason: "EMERGENCY_STOP", failsRun: false },
    { status: "CRITIC", pauseReason: null, failsRun: false },
  ] as const)(
    "settles a rejection once without replacing run state $status / $pauseReason",
    async ({ status, pauseReason, failsRun }) => {
      const t = await fixture.tenant();
      const attempt = await newAttempt(t);
      const nonce = randomUUID();
      const dispatchKey = attempt.idempotencyKey;
      const scope = { workspaceId: t.run.workspaceId, runId: t.run.id };
      const stage = await t.db.videoRunStep.create({
        data: {
          ...scope,
          key: "PLANNING",
          idempotencyKey: randomUUID(),
          state: "RUNNING",
          input: {},
        },
      });
      const { reservationId } = await t.db.$transaction(async (tx) => {
        const locked = await lockTextAttempt(tx, t.context.workspaceId, attempt.id);
        await appendTextEvidence(tx, locked, {
          kind: "PREPARED",
          eventKey: "prepared",
          data: { dispatchKey, modelId: "fixture", estimateMinor: 7, stage: "PLANNING" },
        });
        await tx.budgetEnvelope.create({ data: { ...scope, spentMinor: 19, reservedMinor: 11 } });
        const reservation = await tx.usageReservation.create({
          data: {
            workspaceId: scope.workspaceId,
            channelId: t.run.channelId,
            amountMinor: 7n,
            category: "LLM",
            currency: "USD",
            correlationId: attempt.id,
            idempotencyKey: `m08:${dispatchKey}`,
            expiresAt: new Date(Date.now() + 100_000),
          },
        });
        await tx.providerRequest.create({
          data: {
            workspaceId: scope.workspaceId,
            channelId: t.run.channelId,
            correlationId: attempt.id,
            providerId: "gemini",
            capabilityId: "fixture",
            currency: "USD",
            estimatedCost: 0.07,
            status: "FAILED",
            errorCode: "PENDING",
          },
        });
        await appendTextEvidence(tx, locked, {
          kind: "ARMED",
          eventKey: "arm",
          nonce,
          data: { reservationId: reservation.id },
        });
        await foldTextAttempt(tx, t.context, attempt.id);
        return { reservationId: reservation.id };
      });
      expect(await t.db.budgetEnvelope.findFirst({ where: scope })).toMatchObject({
        reservedMinor: 18,
        spentMinor: 19,
      });
      await t.db.videoRun.updateMany({
        where: { workspaceId: scope.workspaceId, id: scope.runId },
        data: { state: status, pauseReason },
      });
      await t.db.$transaction(async (tx) => {
        const locked = await lockTextAttempt(tx, t.context.workspaceId, attempt.id);
        await appendTextEvidence(tx, locked, {
          kind: "REJECTED",
          eventKey: "response",
          nonce,
          data: { dispatchKey, code: "UNAUTHENTICATED", httpStatus: 401 },
        });
      });
      const apply = async (fail: boolean): Promise<void> =>
        t.db.$transaction(async (tx) => {
          await lockTextAttempt(tx, t.context.workspaceId, attempt.id);
          await foldTextAttempt(tx, t.context, attempt.id);
          if (fail) {
            expect(
              await tx.usageReservation.findUniqueOrThrow({ where: { id: reservationId } }),
            ).toMatchObject({ status: "RELEASED" });
            throw new Error("settlement transaction aborted");
          }
        });
      await expect(apply(true)).rejects.toThrow("settlement transaction aborted");
      if (failsRun) {
        // Force the CI interleaving: a different worker sweeps after the journal commit
        // and rollback, before this worker reads back the reservation.
        const { t: peer } = await runtimeFixture(fixture);
        const recover = vi.spyOn(peer.planning, "recoverText");
        await peer.engine.recover();
        expect(recover.mock.calls.map(([context]) => context.workspaceId)).toEqual([
          peer.context.workspaceId,
        ]);
      }
      expect(
        await t.db.usageReservation.findUnique({ where: { id: reservationId } }),
      ).toMatchObject({
        status: "RESERVED",
      });
      expect(
        await t.db.textAttemptEvidence.count({
          where: { workspaceId: scope.workspaceId, attemptId: attempt.id, kind: "REJECTED" },
        }),
      ).toBe(1);
      await apply(false);
      await apply(false);
      expect(
        await t.db.usageReservation.findUnique({ where: { id: reservationId } }),
      ).toMatchObject({
        status: "RELEASED",
        committedMinor: null,
      });
      expect(await t.db.budgetEnvelope.findFirst({ where: scope })).toMatchObject({
        reservedMinor: 11,
        spentMinor: 19,
      });
      expect(
        await t.db.runEvent.count({
          where: { ...scope, stepId: attempt.id, type: "text_attempt_folded" },
        }),
      ).toBe(failsRun ? 1 : 2);
      expect(
        await t.db.videoRun.findFirst({
          where: { workspaceId: scope.workspaceId, id: scope.runId },
        }),
      ).toMatchObject({
        state: failsRun ? "FAILED" : status,
        pauseReason: failsRun ? "UNAUTHENTICATED" : pauseReason,
      });
      expect(
        await t.db.videoRunStep.findFirst({ where: { ...scope, id: stage.id } }),
      ).toMatchObject({
        state: failsRun ? "FAILED" : "RUNNING",
      });
    },
  );
});
