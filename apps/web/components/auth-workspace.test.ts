import { describe, expect, it } from "vitest";
import { validateAuth } from "../lib/auth-validation";

describe("authentication form validation", () => {
  it("requires a valid email and the backend password minimum", () => {
    expect(validateAuth("", "long-enough-password", "Name", "signin")).toContain("email");
    expect(validateAuth("creator@example.com", "short", "Name", "signin")).toContain("12");
    expect(validateAuth("creator@example.com", "long-enough-password", "Name", "signin")).toBe("");
  });

  it("requires a display name only during registration", () => {
    expect(validateAuth("creator@example.com", "long-enough-password", "", "register")).toContain(
      "display name",
    );
    expect(validateAuth("creator@example.com", "long-enough-password", "", "signin")).toBe("");
  });
});
