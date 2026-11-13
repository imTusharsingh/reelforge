import { describe, expect, it } from "vitest";
import { withCsrf } from "./csrf";

describe("browser CSRF headers", () => {
  it("adds the cookie token only to unsafe requests", () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "reelforge_csrf=token-123" },
    });
    expect(new Headers(withCsrf({ method: "POST" }).headers).get("X-CSRF-Token")).toBe("token-123");
    expect(new Headers(withCsrf({ method: "GET" }).headers).has("X-CSRF-Token")).toBe(false);
  });
});
