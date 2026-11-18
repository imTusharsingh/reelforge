import { describe, expect, it } from "vitest";
import { PublishingPackageSchema } from "./publishing-automation.js";
describe("V9 temporary V6 packaging boundary", () => {
  const pack = {
    videoRunId: "11111111-1111-4111-8111-111111111111",
    criticStepId: "22222222-2222-4222-8222-222222222222",
    assemblyStepId: "33333333-3333-4333-8333-333333333333",
    title: "Science",
    description: "Original story",
    tags: ["science"],
    coverFrameTimestampMs: 1000,
    containsSyntheticMedia: true,
  };
  it("requires valid IDs, YouTube limits and mandatory synthetic disclosure", () => {
    expect(PublishingPackageSchema.parse(pack)).toEqual(pack);
    for (const change of [
      { title: "a".repeat(101) },
      { containsSyntheticMedia: false },
      { criticStepId: "bad" },
      { extra: true },
    ])
      expect(PublishingPackageSchema.safeParse({ ...pack, ...change }).success).toBe(false);
    expect(
      PublishingPackageSchema.safeParse({
        ...pack,
        renderJobId: "44444444-4444-4444-8444-444444444444",
        qualityReviewRunId: "55555555-5555-4555-8555-555555555555",
      }).success,
    ).toBe(false);
  });
});
