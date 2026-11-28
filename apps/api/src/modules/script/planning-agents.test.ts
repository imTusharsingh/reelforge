import { describe, expect, it, vi } from "vitest";
import {
  PlanningFormatSchema,
  PlanningScriptSchema,
  planningTranscript,
  validatePlanningScript,
  words,
} from "@reelforge/contracts";
import { planningPrompts } from "../config/planning-prompts.js";
import { ScriptwriterService, DirectorService } from "./planning-agents.js";
import { context, planningFixture, scriptFixture, shotsFixture } from "./planning.fixture.js";
import { screenPlanningContent, validatePlanningAccess } from "./planning-guardrails.js";
import type { PlanningPromptService } from "../config/planning-prompt.service.js";
const prompts = {
  format: vi.fn().mockResolvedValue({
    version: 1,
    structure: { opening: "hook", body: "beats", closing: "cta" },
  }),
  capture: vi.fn().mockResolvedValue({ prompt: "instructions", receipt: { version: 2 } }),
} as unknown as PlanningPromptService;
describe("V4 structured planning", () => {
  it.each(PlanningFormatSchema.options)(
    "accepts recorded script and director fixtures for %s",
    async (format) => {
      const request = planningFixture();
      request.format = format;
      const generate = vi
        .fn()
        .mockResolvedValueOnce(scriptFixture())
        .mockResolvedValueOnce(shotsFixture(request));
      const written = await new ScriptwriterService({ generate }, prompts).write(context, request);
      const directed = await new DirectorService({ generate }, prompts).direct(
        context,
        request,
        written.script,
      );
      expect(directed.shots).toHaveLength(6);
      expect(directed.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)).toBe(45);
      expect(generate).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    { hook: "" },
    { cta: "" },
    { beats: ["one"] },
    { beats: Array(6).fill("beat") },
    { hook: "word ".repeat(21) },
    { cta: "word ".repeat(16) },
    { wordCount: 999 },
    { payoff: "word ".repeat(200) },
  ])("rejects malformed scripts: %j", (patch) => {
    expect(() =>
      validatePlanningScript({ ...scriptFixture(), ...patch }, planningFixture()),
    ).toThrow();
  });
  it.each([10, 11])("applies the prompted word limit to a %i-word hook", (length) => {
    const request = planningFixture();
    const script = { ...scriptFixture(), hook: Array<string>(length).fill("leaf").join(" ") };
    script.wordCount = words(planningTranscript(script));
    expect(planningPrompts.scriptwriter.sections.instructions).toContain("at most 10 words");
    expect(PlanningScriptSchema.safeParse(script).success).toBe(length === 10);
    if (length === 10) expect(validatePlanningScript(script, request)).toEqual(script);
    else expect(() => validatePlanningScript(script, request)).toThrow("at most 10 words");
  });
  it("enforces duration budget and Brief language", () => {
    const request = planningFixture();
    request.brief.narratorVoice!.pace = 0.1;
    expect(() => validatePlanningScript(scriptFixture(), request)).toThrow("duration budget");
    request.brief.narratorVoice!.pace = 1;
    request.brief.targetDurationSeconds = 3;
    expect(() => validatePlanningScript(scriptFixture(), request)).toThrow("duration budget");
    request.brief.targetDurationSeconds = 45;
    request.brief.languages.script = "Hindi";
    expect(() => validatePlanningScript(scriptFixture(), request)).toThrow("Brief language");
  });
  it.each([
    "Elon Musk explores space",
    "An AI doctor gives health advice",
    "AI finance advisor recommends stocks",
    "violence",
    "gambling",
    "music with lyrics",
    "in the style of an artist",
  ])("blocks before provider dispatch: %s", async (idea) => {
    const request = planningFixture();
    request.idea = idea;
    const generate = vi.fn();
    await expect(
      new ScriptwriterService({ generate }, prompts).write(context, request),
    ).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
  it("screens outputs and rejects foreign and viewer requests", () => {
    const request = planningFixture();
    expect(() => screenPlanningContent(request, "Taylor Swift")).toThrow();
    expect(() => validatePlanningAccess({ ...context, role: "VIEWER" }, request)).toThrow();
    expect(() => validatePlanningAccess({ ...context, workspaceId: "foreign" }, request)).toThrow();
    request.brief.narratorVoice = null;
    expect(() => validatePlanningAccess(context, request)).toThrow("narrator");
  });
  it("rejects bad shot durations before media", async () => {
    const request = planningFixture();
    const shots = shotsFixture(request);
    shots[0]!.durationSeconds = 3;
    await expect(
      new DirectorService({ generate: vi.fn().mockResolvedValue(shots) }, prompts).direct(
        context,
        request,
        scriptFixture(),
      ),
    ).rejects.toThrow("duration mismatch");
    shots[0]!.durationSeconds = 11;
    await expect(
      new DirectorService({ generate: vi.fn().mockResolvedValue(shots) }, prompts).direct(
        context,
        request,
        scriptFixture(),
      ),
    ).rejects.toThrow();
  });
  it("rejects non-720p storyboard shots before media", async () => {
    const request = planningFixture();
    const shots = shotsFixture(request);
    shots[0] = { ...shots[0]!, width: 1080, height: 1920 };
    await expect(
      new DirectorService({ generate: vi.fn().mockResolvedValue(shots) }, prompts).direct(
        context,
        request,
        scriptFixture(),
      ),
    ).rejects.toThrow("Planning shots must be 720 × 1280");
  });
});

it("rejects a 99-word script that fits the narration budget but cannot fit readable captions", async () => {
  const request = planningFixture();
  request.brief.targetDurationSeconds = 30;
  const beat = [
    ...Array<string>(16).fill("spacecraft"),
    ...Array<string>(14).fill("astronaut"),
  ].join(" ");
  const script = {
    ...scriptFixture(),
    beats: [beat, beat, beat],
    payoff: "Interplanetary",
    wordCount: 0,
  };
  script.cta = "Watch trees grow now";
  script.wordCount = words(planningTranscript(script));
  expect(script.wordCount).toBe(99);
  expect(planningTranscript(script).replace(/\s/gu, "")).toHaveLength(906);
  expect(() => validatePlanningScript(script, request)).toThrow("readable caption duration");
  expect(validatePlanningScript(scriptFixture(), request)).toEqual(scriptFixture());
  request.brief.targetDurationSeconds = 45;
  expect(() => validatePlanningScript(script, request)).toThrow("readable caption duration");
  expect(validatePlanningScript(scriptFixture(), request)).toEqual(scriptFixture());
  const generate = vi.fn();
  await expect(
    new DirectorService({ generate }, prompts).direct(context, request, script),
  ).rejects.toThrow("readable caption duration");
  expect(generate).not.toHaveBeenCalled();
});

it("rejects a 30s plan that only fits if the renderer could split its natural phrases", async () => {
  const line = (count: number): string => Array<string>(count).fill("planet").join(" ");
  const script = {
    hook: line(4),
    beats: [line(26), line(26), line(26)],
    payoff: line(4),
    cta: line(4),
    language: "English",
    wordCount: 90,
  };
  const request = planningFixture();
  request.brief.targetDurationSeconds = 31;
  expect(validatePlanningScript(script, request)).toEqual(script);
  request.brief.targetDurationSeconds = 30;
  const generate = vi.fn();
  await expect(
    new DirectorService({ generate }, prompts).direct(context, request, script),
  ).rejects.toThrow("readable caption duration");
  expect(generate).not.toHaveBeenCalled();
});
