/** Strangler registry. Wave 0 adds persistence only; V3 is responsible for consuming this flag. */
/** @deprecated Strangler flag removed in T2 after V8 switches to VideoRun. */
export const FEATURE_FLAGS = {
  "pipeline.v2": { environment: "PIPELINE_V2", default: false },
} as const;
export function pipelineV2Enabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[FEATURE_FLAGS["pipeline.v2"].environment] === "true";
}
