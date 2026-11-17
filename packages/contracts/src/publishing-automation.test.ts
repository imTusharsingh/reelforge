import { describe, expect, it } from "vitest";
import { PublishingPackageSchema } from "./publishing-automation.js";
describe("V9 temporary V6 packaging boundary", () => {
  const pack = {
    renderJobId: "11111111-1111-4111-8111-111111111111",
    qualityReviewRunId: "22222222-2222-4222-8222-222222222222",
    title: "Science",
    description: "Original story",
    tags: ["science"],
    coverFrame: "cover.png",
    containsSyntheticMedia: true,
  };
  it("requires valid IDs, YouTube limits and mandatory synthetic disclosure", () => {
    expect(PublishingPackageSchema.parse(pack)).toEqual(pack);
    for (const change of [
      { title: "a".repeat(101) },
      { containsSyntheticMedia: false },
      { qualityReviewRunId: "bad" },
      { extra: true },
    ])
      expect(PublishingPackageSchema.safeParse({ ...pack, ...change }).success).toBe(false);
  });
});
