import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
const me = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "creator@example.com",
  displayName: "Creator",
};
afterEach(() => vi.unstubAllGlobals());
describe("account API", () => {
  it("loads and saves the current profile through authenticated requests", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(me))));
    vi.stubGlobal("fetch", fetch);
    expect(await api.me()).toEqual(me);
    expect(await api.updateMe("Creator")).toEqual(me);
    expect(fetch.mock.calls[1]).toEqual([
      "/api/v1/auth/me",
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        body: JSON.stringify({ displayName: "Creator" }),
      }),
    ]);
  });
  it("changes the password and validates the revocation count", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, revokedSessions: 2 })));
    vi.stubGlobal("fetch", fetch);
    expect(await api.changePassword("current-password", "new-password-123")).toEqual({
      ok: true,
      revokedSessions: 2,
    });
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({
      currentPassword: "current-password",
      newPassword: "new-password-123",
    });
  });
  it.each([400, 401, 429])(
    "preserves password error %s and its safe error code",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ message: "Rejected", code: "ACCOUNT_ERROR" }), {
            status,
          }),
        ),
      );
      await expect(api.changePassword("current", "new-password-123")).rejects.toMatchObject({
        status,
        code: "ACCOUNT_ERROR",
      });
    },
  );
  it("rejects malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ ok: true, revokedSessions: -1 }))),
        ),
    );
    await expect(api.changePassword("current", "new-password-123")).rejects.toMatchObject({
      status: 502,
    });
    await expect(api.me()).rejects.toMatchObject({ status: 502 });
  });
});
