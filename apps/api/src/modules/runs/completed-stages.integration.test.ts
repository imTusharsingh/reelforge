import { describe, expect, it } from "vitest";
import { runsFixture } from "./runs.fixture.js";

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
});
