import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { parseOAuthCallback, requireYouTubeCallbackUrl } from "./social-accounts.validation.js";

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

describe("Configured YouTube callback URL", () => {
  it.each(["youtube", "YOUTUBE"])("accepts the API callback for %s", (platform) => {
    const url = `https://api.example.test/api/v1/social-accounts/oauth/${platform}/callback`;
    expect(requireYouTubeCallbackUrl(url)).toBe(url);
  });
  it.each([
    undefined,
    "/api/v1/social-accounts/oauth/youtube/callback",
    "https://api.example.test/social-accounts/oauth/youtube/callback",
    "https://api.example.test/api/v1/social-accounts/oauth/instagram/callback",
    "https://api.example.test/api/v1/social-accounts/oauth/youtube/callback/",
  ])("rejects an invalid callback URL %s", (url) => {
    expect(() => requireYouTubeCallbackUrl(url)).toThrow("YOUTUBE_OAUTH_CALLBACK_URL");
  });
});
