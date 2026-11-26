import { describe, expect, it } from "vitest";
import { planningFixture, scriptFixture, shotsFixture, context } from "./planning.fixture.js";
import { validatePlanningShots } from "./planning-validation.js";
import { validatePlanningAccess } from "./planning-guardrails.js";
import { pinPlanningShots } from "./planning-shots.js";
import type { ReferenceLibrary } from "../reference-library/planning.ports.js";
describe("V4 planning trust boundaries", () => {
  it.each([
    [29, 30, false],
    [30, 30, true],
    [31, 30, true],
    [32, 30, false],
    [45, 45, true],
    [46, 45, false],
  ] as const)(
    "checks both the assembly bounds and target tolerance for %is against %is",
    (seconds, target, valid) => {
      const request = planningFixture();
      request.brief.targetDurationSeconds = target;
      const shots = shotsFixture(request).map((shot, index) => ({
        ...shot,
        durationSeconds: Math.floor(seconds / 6) + Number(index < seconds % 6),
      }));
      if (valid) expect(validatePlanningShots(shots, request)).toEqual(shots);
      else expect(() => validatePlanningShots(shots, request)).toThrow("Shot duration mismatch");
    },
  );
  it("rejects duplicate ids, foreign shots, wrong fps and missing narration", () => {
    const request = planningFixture();
    let shots = shotsFixture(request);
    shots[1]!.id = shots[0]!.id;
    expect(() => validatePlanningShots(shots, request)).toThrow("Duplicate");
    shots = shotsFixture(request);
    shots[0]!.fps = 30;
    expect(() => validatePlanningShots(shots, request)).toThrow("frame rate");
    shots = shotsFixture(request);
    shots[0]!.workspaceId = request.runId;
    expect(() => validatePlanningShots(shots, request)).toThrow("identity");
    shots = shotsFixture(request);
    shots[0]!.voLine = "Different narration";
    expect(() => validatePlanningShots(shots, request, scriptFixture())).toThrow("preserve");
    shots = shotsFixture(request);
    shots[2]!.firstFrameFrom = { previousShotOrdinal: 0 };
    expect(() => validatePlanningShots(shots, request)).toThrow("preceding");
  });
  it("keeps non-English speech exclusively in TTS", () => {
    const request = planningFixture();
    request.brief.languages.script = "Hindi";
    request.brief.languages.narration = "Hindi";
    const shots = shotsFixture(request);
    expect(validatePlanningShots(shots, request)).toHaveLength(6);
    shots[0]!.dialogue = "spoken words";
    expect(() => validatePlanningShots(shots, request)).toThrow("TTS");
    request.brief.languages.narration = "English";
    expect(() => validatePlanningAccess(context, request)).toThrow("same Brief language");
  });
  it("rejects foreign pinning input and supports explicit Brief references", async () => {
    const request = planningFixture();
    const shots = shotsFixture(request);
    const library: Pick<ReferenceLibrary, "defaults" | "resolve"> = {
      defaults: async (): Promise<null> => null,
      resolve: async (): Promise<[]> => [],
    };
    expect(await pinPlanningShots(context, request, shots, library)).toHaveLength(6);
    await expect(
      pinPlanningShots({ ...context, workspaceId: request.runId }, request, shots, library),
    ).rejects.toThrow("Foreign Brief");
    shots[0]!.runId = request.brief.id;
    await expect(pinPlanningShots(context, request, shots, library)).rejects.toThrow(
      "Foreign shot",
    );
  });
});
