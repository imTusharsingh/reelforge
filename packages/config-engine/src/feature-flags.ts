/** Strangler registry. Wave 0 adds persistence only; V3 is responsible for consuming this flag. */
export const FEATURE_FLAGS = {
  "pipeline.v2": { environment: "PIPELINE_V2", default: false },
} as const;
export function pipelineV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[FEATURE_FLAGS["pipeline.v2"].environment] === "true";
}
