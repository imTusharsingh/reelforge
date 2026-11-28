import { expect, it } from "vitest";
import { runStepCategory } from "./usage-budget.types.js";
it.each([
  ["shot-0", "VIDEO_MEDIA"],
  ["media:keyframe:0:v1", "IMAGE_MEDIA"],
  ["media:reference:42", "IMAGE_MEDIA"],
  ["media:narration", "TTS"],
  ["media:music", "MUSIC"],
  ["media:text:scriptwriter", "LLM"],
  ["future-step", "UNCATEGORIZED"],
])("classifies %s as %s", (key, expected) => {
  expect(runStepCategory(key!)).toBe(expected);
});
