import { describe, expect, it } from "vitest";
import { nextTabIndex } from "./tab-navigation";

describe("M21 keyboard tab navigation", () => {
  it("wraps horizontal arrow navigation in both directions", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
  });

  it("supports Home and End and leaves unhandled keys alone", () => {
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
    expect(nextTabIndex("Tab", 1, 3)).toBeNull();
    expect(nextTabIndex("Escape", 1, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
