import { describe, expect, it, vi } from "vitest";
import { generateClips, generating, runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("Run reshoot limits", () => {
  const fixture = runsFixture();

  it("limits full re-edits to one and shot reshoots to two", async () => {
    const t = await fixture.tenant("L2", 30);
    await generating(t);
    await generateClips(t);
    await t.db.budgetEnvelope.updateMany({
      where: { runId: t.run.id },
      data: { reshootReserveMinor: 200 },
    });
    await t.engine.process(t.runs.job(t.context, t.run.id));
    await t.engine.process(t.runs.job(t.context, t.run.id));
    expect((await t.store.get(t.context, t.run.id)).state).toBe("CRITIC");
    await t.control.reedit(t.context, t.run.id);
    await expect(t.control.reedit(t.context, t.run.id)).rejects.toThrow("one full re-edit");
    // Give both reshoots enough room. All new paid calls still use M18 and the envelope.
    for (let i = 0; i < 2; i++) {
      const source = await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: t.run.id, key: "shot-0" },
        orderBy: { attempt: "desc" },
      });
      const submit = vi.spyOn(t.generation.provider, "submit");
      const replay = (): Promise<string | null> =>
        t.control.reshoot(t.context, t.run.id, 0, source.id);
      const [a, b] = await Promise.all([replay(), replay()]);
      expect(a).toBe(b);
      expect(await replay()).toBe(a);
      await generateClips(t);
      expect(submit).toHaveBeenCalledOnce();
      submit.mockRestore();
      await t.engine.process(t.runs.job(t.context, t.run.id));
      await t.engine.process(t.runs.job(t.context, t.run.id));
    }
    const last = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "shot-0", attempt: 3 },
    });
    await t.control.reshoot(t.context, t.run.id, 0, last.id);
    expect((await t.store.get(t.context, t.run.id)).state).toBe("NEEDS_HUMAN");
    await t.control.resume(t.context, t.run.id);
    await expect(t.control.resume(t.context, t.run.id)).rejects.toThrow();
  });
});
