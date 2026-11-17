import { afterEach, describe, expect, it, vi } from "vitest";
import { studioDestinations } from "./pipeline-navigation";
afterEach(() => vi.unstubAllEnvs());
describe("V8 pipeline UI switch", () => {
  it("defaults on and preserves manual idea approval and insights", () => {
    vi.stubEnv("NEXT_PUBLIC_PIPELINE_V2", undefined);
    const paths = studioDestinations().map((d) => d.href);
    for (const path of ["/runs", "/approvals", "/usage", "/planning", "/insights"])
      expect(paths).toContain(path);
    for (const path of ["/production", "/review"]) expect(paths).not.toContain(path);
  });
  it("supports an explicit UI rollback without replacing server configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_PIPELINE_V2", "false");
    expect(studioDestinations().map((d) => d.href)).toContain("/production");
    expect(studioDestinations(false).map((d) => d.href)).toContain("/review");
  });
});
