import { ingestMatchedTextRejection } from "./text-attempt-receipt-recovery.js";
import { drainedLegacyIncarnation } from "./text-attempt-ops-schema.js";
import { legacy } from "./legacy-text-import.fixture.js";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { accepted, invocation } from "../runs/text-attempt-runtime.fixture.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { Json, Step } from "../runs/runs.types.js";
import { importLegacyTextAttempts } from "./legacy-text-import.js";
import { canOwnerConfirmText, confirmTextAttempt } from "./text-attempt-owner.js";
import { readTextAttempt } from "./text-attempt-store.js";

async function activity(t: Tenant, step: Step, type: string, payload: Json): Promise<void> {
  await t.store.mutate(t.context, step.runId, type, async () => ({
    value: null,
    stepId: step.id,
    payload,
  }));
}
const apply = (t: Tenant): ReturnType<typeof importLegacyTextAttempts> =>
  importLegacyTextAttempts(t.db, {
    workspaceId: t.run.workspaceId,
    apply: true,
    oldWritersDrained: true,
    auditId: "fixture-change-170",
  });

async function retryOnlyProved(t: Tenant, proven: Step, decoy: Step): Promise<void> {
  const native = fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    {
      clip: Buffer.alloc(0),
      image: Buffer.alloc(0),
      audio: Buffer.alloc(0),
    },
    [],
  );
  const { accounts } = bindMedia(t, native);
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
  const run = await t.store.get(t.context, t.run.id);
  await expect(
    accounts.begin(t.context, run, decoy.key, {}, 7, "fixture-text", true),
  ).rejects.toThrow("RECONCILE_REQUIRED");
  const current = await t.store.get(t.context, t.run.id);
  const fresh = await accounts.begin(t.context, current, proven.key, {}, 7, "fixture-text", true);
  expect(fresh.idempotencyKey).not.toBe(proven.idempotencyKey);
  const post = vi.fn(accepted());
  const dispatch = (): ReturnType<typeof accounts.dispatchTextAttempt> =>
    accounts.dispatchTextAttempt(t.context, fresh, invocation(fresh, post));
  await expect(dispatch()).resolves.toMatchObject({ dispatchKey: fresh.idempotencyKey });
  await expect(dispatch()).rejects.toThrow();
  expect(post).toHaveBeenCalledOnce();
  expect(
    await t.db.usageReservation.findFirst({
      where: { workspaceId: proven.workspaceId, idempotencyKey: `m08:${proven.idempotencyKey}` },
    }),
  ).toMatchObject({ status: "EXPIRED", committedMinor: null });
}

describe.skipIf(!process.env.DATABASE_URL)("audited legacy text upgrade", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it("keeps bare v1/v2 arms held, releases only unarmed preparations and imports twice safely", async () => {
    const t = await fixture.tenant();
    const sent = await legacy(t, "sent", { expired: true });
    await activity(t, sent, "text_dispatch_started", { dispatchKey: sent.idempotencyKey });
    const bareV1 = await legacy(t, "bare-1", { expired: true });
    await activity(t, bareV1, "provider_dispatch", { idempotencyKey: bareV1.idempotencyKey });
    const bareV2 = await legacy(t, "bare-2", {
      expired: true,
      metadata: {
        dispatched: true,
        costKnown: false,
        textDispatchProtocol: "sync-text-advisory-v2",
        ownerReportedEvidence: { providerJobId: "unverified-owner", usage: { input_tokens: 22 } },
      },
    });
    const prepared = await legacy(t, "preparation", {
      code: "VIDEO_RUN_TEXT_PREPARED",
      metadata: {
        dispatched: false,
        costKnown: false,
        textDispatchProtocol: "sync-text-advisory-v2",
      },
    });
    const dry = await importLegacyTextAttempts(t.db, { workspaceId: t.run.workspaceId });
    expect(dry.mode).toBe("dry-run");
    expect(dry.attempts).toHaveLength(4);
    expect(
      await t.db.textAttemptEvidence.count({ where: { workspaceId: t.run.workspaceId } }),
    ).toBe(0);
    await expect(
      importLegacyTextAttempts(t.db, { workspaceId: t.run.workspaceId, apply: true }),
    ).rejects.toThrow("old writers");
    expect((await apply(t)).attempts.map(({ outcome }) => outcome).sort()).toEqual([
      "held",
      "held",
      "non-dispatched",
      "sent",
    ]);
    expect((await apply(t)).attempts.every(({ action }) => action === "already-imported")).toBe(
      true,
    );
    expect(await canOwnerConfirmText(t.db, sent, t.context, t.artifacts)).toBe(true);
    for (const step of [bareV1, bareV2]) {
      expect(await readTextAttempt(t.db, step)).toMatchObject({
        phase: "ARMED",
        positiveSent: false,
        reservedMinor: 7,
        netMinor: 0,
        googleId: null,
      });
      expect(await canOwnerConfirmText(t.db, step, t.context, t.artifacts)).toBe(false);
    }
    expect(await readTextAttempt(t.db, prepared)).toMatchObject({
      phase: "NOT_DISPATCHED",
      reservedMinor: 0,
      netMinor: 0,
      armNonce: null,
    });
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
    await expect(confirmTextAttempt(t.runs, t.context, sent.runId, bareV2.id)).rejects.toThrow();
    await confirmTextAttempt(t.runs, t.context, sent.runId, sent.id);
    await confirmTextAttempt(t.runs, t.context, sent.runId, sent.id);
    expect(
      await t.db.textAttemptEvidence.count({
        where: { attemptId: sent.id, kind: "OWNER_CONFIRMED" },
      }),
    ).toBe(1);
    expect(
      await t.db.usageReservation.findFirst({ where: { correlationId: sent.id } }),
    ).toMatchObject({
      status: "COMMITTED",
      committedMinor: 7n,
    });
    expect(
      await t.db.usageReservation.findFirst({ where: { correlationId: prepared.id } }),
    ).toMatchObject({
      status: "RELEASED",
      committedMinor: null,
    });
  });

  it("uses only an exact pre-POST release, including expired old reservations without a fenced flag", async () => {
    const t = await fixture.tenant();
    const proven = await legacy(t, "released", {
      expired: true,
      cancelled: true,
      detached: true,
      code: "NOT_DISPATCHED",
    });
    const decoy = await legacy(t, "decoy", {
      expired: true,
      cancelled: true,
      detached: true,
      code: "NOT_DISPATCHED",
    });
    await activity(t, proven, "provider_dispatch", { idempotencyKey: proven.idempotencyKey });
    await activity(t, proven, "dispatch_released", { reason: "NOT_DISPATCHED" });
    await activity(t, decoy, "dispatch_released", {
      reason: "NOT_DISPATCHED",
      dispatchKey: proven.idempotencyKey,
    });
    const first = await apply(t);
    expect(first.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptId: proven.id, outcome: "non-dispatched" }),
        expect.objectContaining({ attemptId: decoy.id, action: "blocked" }),
      ]),
    );
    const second = await apply(t);
    expect(second.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptId: proven.id, action: "already-imported" }),
        expect.objectContaining({ attemptId: decoy.id, action: "blocked" }),
      ]),
    );
    expect(await readTextAttempt(t.db, proven)).toMatchObject({
      phase: "NOT_DISPATCHED",
      grossMinor: 0,
      netMinor: 0,
      reservedMinor: 0,
    });
    expect(await readTextAttempt(t.db, decoy)).toBeNull();
    expect(
      await t.db.usageReservation.findFirst({
        where: { workspaceId: proven.workspaceId, idempotencyKey: `m08:${proven.idempotencyKey}` },
      }),
    ).toMatchObject({
      status: "EXPIRED",
      committedMinor: null,
    });
    await retryOnlyProved(t, proven, decoy);
  });

  it.each([false, true])(
    "links audited credits without rebooking an old commitment (already imported %s)",
    async (imported) => {
      const t = await fixture.tenant();
      const { workspaceId, channelId } = t.run;
      const step = await legacy(t, "booked", { committed: true });
      await activity(t, step, "step_failed", {
        reason: "OWNER_CONFIRMED_TERMINAL_TEXT",
        confirmedBy: t.context.userId,
        committedEstimateMinor: 7,
      });
      if (imported) expect((await apply(t)).attempts[0]?.outcome).toBe("owner-settled");
      const correlationId = randomUUID();
      const credit = await t.db.usageAdjustment.create({
        data: {
          workspaceId,
          channelId,
          kind: "CREDIT",
          currency: "USD",
          amountMinor: 3n,
          actorUserId: t.context.userId,
          correlationId,
          reason: "fixture refund",
        },
      });
      // Historical owner credits carried no attempt or operation key.
      await t.db.usageAuditRecord.create({
        data: {
          workspaceId,
          actorUserId: t.context.userId,
          action: "CREDIT",
          reason: credit.reason,
          correlationId,
          adjustmentId: credit.id,
          after: {
            adjustment: {
              id: credit.id,
              channelId,
              kind: "CREDIT",
              currency: "USD",
              amountMinor: 3,
            },
          },
        },
      });
      expect(await apply(t)).toMatchObject({ unresolvedCreditIds: [credit.id], attempts: [] });
      if (!imported) expect(await readTextAttempt(t.db, step)).toBeNull();
      await t.db.usageAuditRecord.create({
        data: {
          workspaceId,
          actorUserId: t.context.userId,
          action: "CREDIT",
          reason: "fixture refund",
          correlationId,
          adjustmentId: credit.id,
          after: {
            adjustment: {
              id: credit.id,
              textAttemptId: step.id,
              dispatchKey: step.idempotencyKey,
              amountMinor: 3,
              currency: "USD",
              operationKey: "fixture-linked-credit",
            },
          },
        },
      });
      const dry = await importLegacyTextAttempts(t.db, { workspaceId });
      expect(dry.unresolvedCreditIds).toEqual([credit.id]);
      expect(
        (await t.db.usageAdjustment.findUniqueOrThrow({ where: { id: credit.id } })).textAttemptId,
      ).toBeNull();
      const applied = await apply(t);
      expect(applied.unresolvedCreditIds).toEqual([]);
      expect(applied.attempts[0]).toMatchObject({
        ...(imported ? { action: "reconciled" } : { outcome: "owner-settled" }),
        after: { grossMinor: 7, netMinor: 4, reservedMinor: 0 },
      });
      await apply(t);
      expect(
        await t.db.usageReservation.findFirst({ where: { correlationId: step.id } }),
      ).toMatchObject({
        committedMinor: 4n,
        status: "COMMITTED",
      });
      expect(await t.db.usageAdjustment.findUnique({ where: { id: credit.id } })).toMatchObject({
        textAttemptId: step.id,
        operationKey: "fixture-linked-credit",
        createdAt: credit.createdAt,
      });
      expect(await readTextAttempt(t.db, step)).toMatchObject({
        phase: "OWNER_CONFIRMED",
        ownerConfirmed: true,
        positiveSent: false,
        grossMinor: 7,
        netMinor: 4,
      });
      const state = await readTextAttempt(t.db, step);
      await ingestMatchedTextRejection(t.db, {
        target: {
          workspaceId,
          attemptId: step.id,
          dispatchKey: step.idempotencyKey,
          armNonce: state!.armNonce,
          incarnation: drainedLegacyIncarnation,
        },
        actor: "fixture-operator",
        source: "google-project-audit",
        reference: "late-rejection",
        observedAt: new Date().toISOString(),
        code: "UNAUTHENTICATED",
        httpStatus: 401,
      });
      expect(
        await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: step.id } }),
      ).toMatchObject({ committedMinor: 0n });
    },
  );
  it("imports a real stored response and matched late 401 without rebooking either", async () => {
    const t = await fixture.tenant();
    const stored = await legacy(t, "stored", {
      output: {
        output: { title: "fixture" },
        providerJobId: "real-google",
        usage: { input_tokens: 12 },
      },
      committed: true,
      providerJobId: "real-google",
    });
    const pending = await legacy(t, "pending", {
      output: { output: { title: "pending" }, providerJobId: "pending-google" },
      providerJobId: "pending-google",
    });
    const rejected = await legacy(t, "late-401", {
      code: "NOT_DISPATCHED",
      expired: true,
      cancelled: true,
    });
    await t.db.videoRunStep.update({
      where: { id: rejected.id },
      data: { state: "FAILED", error: { code: "PROVIDER_UNAUTHENTICATED" } },
    });
    const outcomes = (await apply(t)).attempts.map(({ outcome }) => outcome).sort();
    expect(outcomes).toEqual(["completed", "pending-completion", "rejected"]);
    const native = fakeMediaPorts(
      t.run.workspaceId,
      t.storage,
      { clip: Buffer.alloc(0), image: Buffer.alloc(0), audio: Buffer.alloc(0) },
      [],
    );
    bindMedia(t, native);
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
    expect((await readTextAttempt(t.db, pending))?.armNonce).toMatch(/^legacy:/);
    await t.engine.recover();
    expect(
      await t.db.usageReservation.findFirstOrThrow({ where: { correlationId: pending.id } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: 7n });
    expect(await readTextAttempt(t.db, stored)).toMatchObject({
      phase: "SUCCEEDED",
      googleId: "real-google",
      actualMinor: null,
      netMinor: 7,
      usage: { input_tokens: 12 },
      output: { title: "fixture" },
    });
    expect(await readTextAttempt(t.db, rejected)).toMatchObject({
      phase: "REJECTED",
      positiveSent: true,
      netMinor: 0,
      rejectionCode: "PROVIDER_UNAUTHENTICATED",
    });
    expect(
      await t.db.usageReservation.findFirst({ where: { correlationId: stored.id } }),
    ).toMatchObject({ status: "COMMITTED", committedMinor: 7n });
    const evidence = await t.db.textAttemptEvidence.findFirstOrThrow({
      where: { workspaceId: stored.workspaceId, attemptId: stored.id, kind: "ARMED" },
    });
    await expect(
      t.db.textAttemptEvidence.update({
        where: { id: evidence.id },
        data: { nonce: "fake" },
      }),
    ).rejects.toThrow("append-only");
    await expect(
      t.db.textAttemptEvidence.create({
        data: {
          workspaceId: stored.workspaceId,
          attemptId: stored.id,
          kind: "ARMED",
          sequence: 90,
          eventKey: "duplicate-arm",
          nonce: "other",
          data: {},
        },
      }),
    ).rejects.toThrow();
  });
});
