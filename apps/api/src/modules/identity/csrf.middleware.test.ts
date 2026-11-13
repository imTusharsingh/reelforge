import { describe, expect, it } from "vitest";
import { createCsrfToken, originAllowed, validateCsrf } from "./csrf.middleware.js";

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
});
