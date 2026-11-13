import { describe, expect, it } from "vitest";
import { csrfFailureMessage, withCsrf } from "./csrf";

describe("browser CSRF headers", () => {
  it("adds the cookie token only to unsafe requests", () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "reelforge_csrf=token-123" },
    });
    expect(new Headers(withCsrf({ method: "POST" }).headers).get("X-CSRF-Token")).toBe("token-123");
    expect(new Headers(withCsrf({ method: "GET" }).headers).has("X-CSRF-Token")).toBe(false);
  });

  it("maps CSRF failures to a retry message even when the server includes a code message", () => {
    expect(csrfFailureMessage({ code: "CSRF_TOKEN_INVALID", message: "CSRF_TOKEN_INVALID" })).toBe(
      "Your secure session expired. Retry the request or sign in again.",
    );
  });
});
