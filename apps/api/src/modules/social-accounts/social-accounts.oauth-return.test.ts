import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { SocialOAuthCallbackController } from "./social-accounts.controller.js";
import { OAuthReturnError, SocialAccountsService } from "./social-accounts.service.js";

const state = "a".repeat(43);
const secret = "provider-secret-code";
const originalOrigin = process.env.WEB_APP_ORIGIN;
afterEach(() => {
  if (originalOrigin === undefined) delete process.env.WEB_APP_ORIGIN;
  else process.env.WEB_APP_ORIGIN = originalOrigin;
});

describe("OAuth browser return", () => {
  it.each([
    ["STATE_INVALID", new OAuthReturnError("STATE_INVALID", "bad state")],
    ["STATE_EXPIRED", new OAuthReturnError("STATE_EXPIRED", "expired")],
    ["ACCESS_DENIED", new OAuthReturnError("ACCESS_DENIED", "denied")],
    ["PLATFORM_NOT_CONFIGURED", new OAuthReturnError("PLATFORM_NOT_CONFIGURED", "missing")],
    ["EXCHANGE_FAILED", new Error(secret)],
  ])("redirects %s without provider details or state", async (code, failure) => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    const completeOAuth = vi.fn().mockRejectedValue(failure);
    const redirect = vi.fn();
    const controller = new SocialOAuthCallbackController({
      completeOAuth,
    } as unknown as SocialAccountsService);
    await controller.callback("YOUTUBE", { state, code: secret }, {
      redirect,
    } as unknown as Response);
    expect(redirect).toHaveBeenCalledWith(
      302,
      `https://studio.example/publishing/accounts?oauthError=${code}`,
    );
    expect(String(redirect.mock.calls[0]?.[1])).not.toContain(state);
    expect(String(redirect.mock.calls[0]?.[1])).not.toContain(secret);
  });
  it("redirects success with the account ID only", async () => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    const completeOAuth = vi.fn().mockResolvedValue({ id: "account-id" });
    const redirect = vi.fn();
    const controller = new SocialOAuthCallbackController({
      completeOAuth,
    } as unknown as SocialAccountsService);
    await controller.callback("YOUTUBE", { state, code: secret }, {
      redirect,
    } as unknown as Response);
    expect(redirect).toHaveBeenCalledWith(
      302,
      "https://studio.example/publishing/accounts?connected=account-id",
    );
  });
  it("keeps the JSON response when no browser origin is configured", async () => {
    delete process.env.WEB_APP_ORIGIN;
    const completeOAuth = vi.fn().mockResolvedValue({ id: "account-id" });
    const controller = new SocialOAuthCallbackController({
      completeOAuth,
    } as unknown as SocialAccountsService);
    await expect(
      controller.callback("YOUTUBE", { state, code: secret }, {} as Response),
    ).resolves.toEqual({ id: "account-id" });
  });
});

describe("OAuth callback HTTP response", () => {
  let app: INestApplication;
  const completeOAuth = vi.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SocialOAuthCallbackController],
      providers: [{ provide: SocialAccountsService, useValue: { completeOAuth } }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it.each([
    "STATE_INVALID",
    "STATE_EXPIRED",
    "ACCESS_DENIED",
    "PLATFORM_NOT_CONFIGURED",
    "EXCHANGE_FAILED",
  ] as const)("returns an actual 302 for %s", async (code) => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    completeOAuth.mockRejectedValueOnce(new OAuthReturnError(code, secret));
    const response = await request(app.getHttpServer() as never)
      .get(`/social-accounts/oauth/YOUTUBE/callback?state=${state}&code=${secret}`)
      .expect(302);
    expect(response.headers.location).toBe(
      `https://studio.example/publishing/accounts?oauthError=${code}`,
    );
    expect(response.headers.location).not.toContain(secret);
    expect(response.headers.location).not.toContain(state);
  });
  it("returns an actual success redirect and preserves JSON fallback", async () => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    completeOAuth.mockResolvedValueOnce({ id: "account-id" });
    await request(app.getHttpServer() as never)
      .get(`/social-accounts/oauth/YOUTUBE/callback?state=${state}&code=${secret}`)
      .expect(302)
      .expect("Location", "https://studio.example/publishing/accounts?connected=account-id");
    delete process.env.WEB_APP_ORIGIN;
    completeOAuth.mockResolvedValueOnce({ id: "account-id" });
    const json = await request(app.getHttpServer() as never)
      .get(`/social-accounts/oauth/YOUTUBE/callback?state=${state}&code=${secret}`)
      .expect(200);
    expect(json.body).toEqual({ id: "account-id" });
  });
});
