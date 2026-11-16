import { describe, expect, it } from "vitest";
import { planningFixture, scriptFixture, shotsFixture, context } from "./planning.fixture.js";
import { validatePlanningShots } from "./planning-validation.js";
import { validatePlanningAccess } from "./planning-guardrails.js";
import { pinPlanningShots } from "./planning-shots.js";
import type { ReferenceLibrary } from "../reference-library/planning.ports.js";
describe("V4 planning trust boundaries", () => {
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
    const library: ReferenceLibrary = {
      defaults: async (): Promise<null> => null,
      resolve: async (): Promise<[]> => [],
      save: async (): Promise<void> => {},
      setDefaults: async (): Promise<void> => {},
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
