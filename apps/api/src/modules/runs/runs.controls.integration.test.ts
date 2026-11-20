import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture, generating, generateClips } from "./runs.fixture.js";
import { ArtifactSchema } from "./runs.types.js";

const suite = describe.skipIf(!process.env.DATABASE_URL);
suite("V3 approval, caps and retention", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it("limits full re-edits to one and shot reshoots to two", async () => {
    const t = await fixture.tenant();
    await generating(t);
    await generateClips(t);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("CRITIC");
    await t.control.reedit(t.context, t.run.id);
    await expect(t.control.reedit(t.context, t.run.id)).rejects.toThrow("one full re-edit");
    // Give both reshoots enough room. All new paid calls still use M18 and the envelope.
    for (let i = 0; i < 2; i++) {
      await t.control.reshoot(t.context, t.run.id, 0);
      await generateClips(t);
      await t.engine.process(t.runs.job(t.context, t.run.id));
      await t.engine.process(t.runs.job(t.context, t.run.id));
    }
    await t.control.reshoot(t.context, t.run.id, 0);
    expect((await t.store.get(t.context, t.run.id)).state).toBe("NEEDS_HUMAN");
    await t.control.resume(t.context, t.run.id);
    await expect(t.control.resume(t.context, t.run.id)).rejects.toThrow();
  });
  it("keeps final and manifest forever and expires draft storage after 14 days", async () => {
    const t = await fixture.tenant();
    const now = Date.now();
    const draft = await t.artifacts.put(
      t.context,
      "keyframes",
      Buffer.from("draft"),
      "application/json",
    );
    const final = await t.artifacts.put(
      t.context,
      "final",
      Buffer.from("draft"),
      "application/json",
    );
    const manifest = await t.artifacts.put(
      t.context,
      "manifest",
      Buffer.from("manifest"),
      "application/json",
    );
    expect(final.expiresAt).toBeNull();
    expect(manifest.expiresAt).toBeNull();
    const step = await t.store.scoped(t.context).videoRunStep.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        key: "retention",
        idempotencyKey: `${t.run.id}:retention`,
        input: {},
        output: { storageArtifacts: [draft, final, manifest] },
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 86400000);
    try {
      await t.artifacts.sweep(t.context);
      await expect(
        t.storage.getObject({ workspaceId: t.context.workspaceId, objectKey: draft.objectKey }),
      ).rejects.toThrow();
      expect(
        await t.storage.getObject({
          workspaceId: t.context.workspaceId,
          objectKey: final.objectKey,
        }),
      ).toEqual(Buffer.from("draft"));
      expect(
        t.artifacts.views(t.context, t.run.id, step.id, [draft, final, manifest]),
      ).toHaveLength(2);
      const expired = { ...draft, expiresAt: new Date(now - 1).toISOString() };
      expect(ArtifactSchema.parse(expired).kind).toBe("keyframes");
    } finally {
      clock.mockRestore();
    }
  });
  it("resumes a cap-refused shot without leaking a reservation or reconciling an unpaid call", async () => {
    const t = await fixture.tenant();
    await generating(t);
    await t.db.usageBudget.updateMany({
      where: { workspaceId: t.context.workspaceId },
      data: { dailyLimitMinor: 1n },
    });
    const submit = vi.spyOn(t.generation.provider, "submit");
    const reconcile = vi.spyOn(t.generation.provider, "reconcile");
    const step = await t.store
      .scoped(t.context)
      .videoRunStep.findFirstOrThrow({ where: { runId: t.run.id, key: "shot-0" } });
    await expect(t.engine.process(t.runs.job(t.context, t.run.id, step.id))).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
    expect((await t.store.get(t.context, t.run.id)).state).toBe("PAUSED_BUDGET");
    expect(
      await t.store.scoped(t.context).videoRunStep.findFirstOrThrow({ where: { id: step.id } }),
    ).toMatchObject({
      state: "PENDING",
      costMinor: null,
      providerId: null,
      providerJobId: null,
      startedAt: null,
    });
    expect(
      await t.store
        .scoped(t.context)
        .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({ reservedMinor: 0, spentMinor: 0 });
    expect(
      await t.db.usageReservation.count({
        where: { workspaceId: t.context.workspaceId, idempotencyKey: `m08:${step.idempotencyKey}` },
      }),
    ).toBe(0);
    expect(
      await t.db.providerRequest.count({
        where: { workspaceId: t.context.workspaceId, correlationId: step.id },
      }),
    ).toBe(0);
    await t.db.usageBudget.updateMany({
      where: { workspaceId: t.context.workspaceId },
      data: { dailyLimitMinor: 2000n },
    });
    await t.control.resume(t.context, t.run.id);
    await t.engine.process(t.runs.job(t.context, t.run.id, step.id));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    const finished = await t.store
      .scoped(t.context)
      .videoRunStep.findFirstOrThrow({ where: { id: step.id } });
    expect(finished.state).toBe("SUCCEEDED");
    expect(
      await t.store
        .scoped(t.context)
        .budgetEnvelope.findFirstOrThrow({ where: { runId: t.run.id } }),
    ).toMatchObject({ reservedMinor: 0, spentMinor: finished.costMinor });
    await generateClips(t);
    for (let i = 0; i < 3; i++) await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("AWAITING_APPROVAL");
  });
});
