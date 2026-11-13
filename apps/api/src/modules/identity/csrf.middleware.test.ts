import { describe, expect, it } from "vitest";
import { createCsrfToken, csrfMiddleware, originAllowed, validateCsrf } from "./csrf.middleware.js";

function runMiddleware(input: {
  method: string;
  path: string;
  cookie?: string;
  token?: string;
  origin?: string;
  authorization?: string;
}): unknown {
  let result: unknown;
  csrfMiddleware(
    {
      method: input.method,
      path: input.path,
      headers: {
        ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
        ...(input.token === undefined ? {} : { "x-csrf-token": input.token }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
      },
    } as never,
    {} as never,
    (error?: unknown) => {
      result = error;
    },
  );
  return result;
}

describe("CSRF validation", () => {
  it("uses a cryptographically random base64url token and accepts matching origin", () => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    const token = createCsrfToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() =>
      validateCsrf({
        headers: {
          cookie: `reelforge_csrf=${token}`,
          "x-csrf-token": token,
          origin: "https://studio.example",
        },
      }),
    ).not.toThrow();
  });

  it("rejects bad tokens and missing or mismatched origins", () => {
    const token = createCsrfToken();
    expect(() =>
      validateCsrf({
        headers: {
          cookie: `reelforge_csrf=${token}`,
          "x-csrf-token": "bad",
          origin: "https://studio.example",
        },
      }),
    ).toThrowError("CSRF_TOKEN_INVALID");
    expect(() =>
      validateCsrf({ headers: { cookie: `reelforge_csrf=${token}`, "x-csrf-token": token } }),
    ).toThrowError("CSRF_ORIGIN_INVALID");
    expect(
      originAllowed({ headers: { origin: "https://evil.example" } }, "https://studio.example"),
    ).toBe(false);
    expect(
      originAllowed(
        { headers: { referer: "https://studio.example/login?x=1" } },
        "https://studio.example",
      ),
    ).toBe(true);
  });

  it("checks login and register before a session exists", () => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    const token = createCsrfToken();
    expect(
      runMiddleware({
        method: "POST",
        path: "/api/v1/auth/login",
        origin: "https://studio.example",
      }),
    ).toMatchObject({ response: { code: "CSRF_TOKEN_INVALID" } });
    expect(
      runMiddleware({
        method: "POST",
        path: "/api/v1/auth/register",
        token,
        cookie: `reelforge_csrf=${token}`,
        origin: "https://studio.example",
      }),
    ).toBeUndefined();
  });

  it("only exempts Bearer-only requests and leaves safe/exempt routes untouched", () => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    const token = createCsrfToken();
    expect(
      runMiddleware({
        method: "POST",
        path: "/api/v1/workspaces/w1/items",
        authorization: "Bearer token",
      }),
    ).toBeUndefined();
    expect(
      runMiddleware({
        method: "POST",
        path: "/api/v1/workspaces/w1/items",
        cookie: "reelforge_session=session",
        authorization: "Bearer token",
      }),
    ).toMatchObject({ response: { code: "CSRF_TOKEN_INVALID" } });
    expect(
      runMiddleware({
        method: "GET",
        path: "/api/v1/workspaces/w1/items",
        cookie: "reelforge_session=session",
      }),
    ).toBeUndefined();
    expect(
      runMiddleware({
        method: "POST",
        path: "/api/v1/health",
        cookie: "reelforge_session=session",
      }),
    ).toBeUndefined();
    expect(
      runMiddleware({
        method: "POST",
        path: "/api/v1/workspaces/w1/items",
        cookie: `reelforge_csrf=${token}`,
        token,
        origin: "https://studio.example",
      }),
    ).toBeUndefined();
  });

  it("fails closed when WEB_APP_ORIGIN is unset", () => {
    delete process.env.WEB_APP_ORIGIN;
    const token = createCsrfToken();
    expect(
      runMiddleware({
        method: "POST",
        path: "/api/v1/auth/login",
        cookie: `reelforge_csrf=${token}`,
        token,
      }),
    ).toMatchObject({ response: { code: "CSRF_ORIGIN_INVALID" } });
  });
});
