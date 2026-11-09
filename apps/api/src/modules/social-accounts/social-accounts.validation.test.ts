import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { parseOAuthCallback } from "./social-accounts.validation.js";

describe("OAuth callback validation", () => {
  const state = "A".repeat(43);

  it("accepts a provider denial with standard optional error details", () => {
    expect(
      parseOAuthCallback({
        state,
        error: "access_denied",
        error_description: "User declined authorization",
        error_uri: "https://provider.example/errors/access-denied",
      }),
    ).toMatchObject({ state, error: "access_denied" });
  });

  it("rejects ambiguous authorization code and error responses", () => {
    expect(() =>
      parseOAuthCallback({ state, code: "fixture-code", error: "access_denied" }),
    ).toThrow(BadRequestException);
  });
});
