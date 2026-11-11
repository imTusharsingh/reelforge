import { describe, expect, it } from "vitest";
import { validateAuth } from "../lib/auth-validation";
import { ApiError } from "../lib/api";
import { isAlreadyInvalidSession, sessionFailureMessage } from "../lib/session-policy";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(new URL("./auth-workspace.tsx", import.meta.url), "utf8");

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

describe("authenticated studio route boundary", () => {
  it("uses route content registration instead of pathname-specific booleans", () => {
    expect(workspaceSource).toContain('type StudioRoute = "overview" | "operations"');
    expect(workspaceSource).toContain("studioContent[route]");
    expect(workspaceSource).not.toContain("window.location.pathname");
  });

  it("keeps session actions in the shared shell", () => {
    expect(workspaceSource).toContain("Switch workspace");
    expect(workspaceSource).toContain("Sign out");
    expect(workspaceSource).toContain("shellActions");
  });
});
