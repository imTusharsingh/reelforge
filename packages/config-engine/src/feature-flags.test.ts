import { expect, it } from "vitest";
import { FEATURE_FLAGS, pipelineV2Enabled } from "./index.js";
it("keeps the pipeline.v2 strangler flag off unless explicitly enabled", () => {
  expect(FEATURE_FLAGS["pipeline.v2"].default).toBe(false);
  expect(pipelineV2Enabled({})).toBe(false);
  expect(pipelineV2Enabled({ PIPELINE_V2: "false" })).toBe(false);
  expect(pipelineV2Enabled({ PIPELINE_V2: "true" })).toBe(true);
});
