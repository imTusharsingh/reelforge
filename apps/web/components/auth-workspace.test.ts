import { describe, expect, it } from "vitest";
import { validateAuth } from "../lib/auth-validation";
import { ApiError } from "../lib/api";
import { isAlreadyInvalidSession, sessionFailureMessage } from "../lib/session-policy";

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

  it("only treats an already-invalid session as safe logout completion", () => {
    expect(isAlreadyInvalidSession(new ApiError(401, "expired"))).toBe(true);
    expect(isAlreadyInvalidSession(new ApiError(503, "unavailable"))).toBe(false);
    expect(sessionFailureMessage(new ApiError(503, "unavailable"))).toContain("sign you out");
  });
});
