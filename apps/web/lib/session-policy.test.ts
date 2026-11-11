import { describe, expect, it } from "vitest";
import { isCurrentGeneration } from "./session-policy";

describe("authenticated request generations", () => {
  it("rejects responses from a previous session or workspace generation", () => {
    expect(isCurrentGeneration(4, 4)).toBe(true);
    expect(isCurrentGeneration(5, 4)).toBe(false);
  });
});
