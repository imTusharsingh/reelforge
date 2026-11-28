import { describe, expect, it } from "vitest";
import { generateClips, generating, runsFixture } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("recorded stage completion", () => {
  const fixture = runsFixture();
  it("derives completion from the recorded L2 transition and resets rewound stages", async () => {
    const t = await fixture.tenant("L2");
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const scripting = await t.store.get(t.context, t.run.id);
    expect(scripting).toMatchObject({ state: "SCRIPTING", effectiveAutonomy: "L2" });
    expect(
      await t.store.scoped(t.context).videoRunStep.count({
        where: { runId: t.run.id, key: "PLANNING" },
      }),
    ).toBe(0);
    expect(await t.runs.detail(t.context, t.run.id)).toMatchObject({
      completedStages: ["PLANNING"],
    });

    for (const state of ["SHOT_PLANNING", "GENERATING", "ASSEMBLING", "CRITIC"] as const) {
      const current = await t.store.get(t.context, t.run.id);
      await t.store.transition(t.context, current.id, current.revision, state);
    }
    expect(await t.runs.detail(t.context, t.run.id)).toMatchObject({
      completedStages: ["PLANNING", "SCRIPTING", "SHOT_PLANNING", "GENERATING", "ASSEMBLING"],
    });
    const critic = await t.store.get(t.context, t.run.id);
    await t.store.transition(t.context, critic.id, critic.revision, "GENERATING");
    expect(await t.runs.detail(t.context, t.run.id)).toMatchObject({
      completedStages: ["PLANNING", "SCRIPTING", "SHOT_PLANNING"],
    });
  });

  it("records a rewind only when replaying a reshoot changes the run state", async () => {
    const t = await fixture.tenant("L2", 30);
    await generating(t);
    await generateClips(t);
    await t.db.budgetEnvelope.updateMany({
      where: { runId: t.run.id },
      data: { reshootReserveMinor: 200 },
    });
    const reachCritic = async (): Promise<void> => {
      for (const state of ["ASSEMBLING", "CRITIC"] as const) {
        const current = await t.store.get(t.context, t.run.id);
        await t.store.transition(t.context, current.id, current.revision, state);
      }
    };
    const source = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "shot-0", state: "SUCCEEDED" },
    });
    const reshoot = (): Promise<string | null> =>
      t.control.reshoot(t.context, t.run.id, 0, source.id);
    await reachCritic();
    const replacementId = await reshoot();
    expect(replacementId).not.toBeNull();
    expect(await reshoot()).toBe(replacementId);
    expect((await t.store.events(t.context, t.run.id, 0)).at(-1)).toMatchObject({
      type: "reshoot_replayed",
      payload: { ordinal: 0, attempt: 2 },
    });
    expect((await t.store.events(t.context, t.run.id, 0)).at(-1)?.payload).not.toHaveProperty(
      "from",
    );

    // The pending replacement was not processed; replay can recover a run back at Critic.
    await reachCritic();
    expect(await t.runs.detail(t.context, t.run.id)).toMatchObject({
      completedStages: ["PLANNING", "SCRIPTING", "SHOT_PLANNING", "GENERATING", "ASSEMBLING"],
    });
    expect(await reshoot()).toBe(replacementId);
    const events = await t.store.events(t.context, t.run.id, 0);
    expect(events.at(-1)).toMatchObject({
      type: "reshoot_replayed",
      payload: { ordinal: 0, attempt: 2, from: "CRITIC", to: "GENERATING" },
    });
    expect(events.filter((event) => event.type === "reshoot_requested")).toHaveLength(1);
    expect(await t.runs.detail(t.context, t.run.id)).toMatchObject({
      run: { state: "GENERATING" },
      completedStages: ["PLANNING", "SCRIPTING", "SHOT_PLANNING"],
    });
  });
});
