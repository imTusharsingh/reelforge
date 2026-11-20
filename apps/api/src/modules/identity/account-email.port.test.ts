import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountEmailPort } from "./account-email.port.js";

const resendEnv = {
  RESEND_API_KEY: "test-resend-key",
  ACCOUNT_EMAIL_FROM: "ReelForge <accounts@example.test>",
};
const relayEnv = {
  ACCOUNT_EMAIL_RELAY_URL: "https://relay.example.test/mail",
  ACCOUNT_EMAIL_RELAY_TOKEN: "test-relay-token",
};
const reset = {
  to: "recipient@example.test",
  purpose: "RESET_PASSWORD",
  code: "one-time-code",
} as const;

describe("createAccountEmailPort", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(null, { status: 200 }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers Resend and sends the reset template with a five-second deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const port = createAccountEmailPort({ ...relayEnv, ...resendEnv });
    expect(port.available).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    await port.send(reset);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer test-resend-key",
        "content-type": "application/json",
      },
      signal: timeout.mock.results[0]?.value,
      body: JSON.stringify({
        from: resendEnv.ACCOUNT_EMAIL_FROM,
        to: reset.to,
        subject: "Reset your ReelForge password",
        text: "Paste this one-time code into the password reset form:\n\none-time-code",
        html: "<p>Paste this one-time code into the password reset form:</p><p><strong>one-time-code</strong></p>",
      }),
    });
  });

  it("uses the email-change template and escapes code markup in HTML", async () => {
    const from = "accounts@example.test";
    const port = createAccountEmailPort({ ...resendEnv, ACCOUNT_EMAIL_FROM: from });
    await port.send({ ...reset, purpose: "CHANGE_EMAIL", code: "<b>&</b>" });
    const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(body))).toEqual({
      from,
      to: reset.to,
      subject: "Confirm your ReelForge email change",
      text: "Paste this one-time code into the email change confirmation form:\n\n<b>&</b>",
      html: "<p>Paste this one-time code into the email change confirmation form:</p><p><strong>&lt;b&gt;&amp;&lt;/b&gt;</strong></p>",
    });
  });

  it("throws on a provider rejection without exposing the response or switching to relay", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(reset.code, { status: 429 }));
    const port = createAccountEmailPort({ ...resendEnv, ...relayEnv });
    await expect(port.send(reset)).rejects.toEqual(
      new Error("Account email Resend rejected delivery"),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(port.available).toBe(true);
  });

  it("does not retry an accepted delivery when discarding the response fails", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("response stream error"));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    await expect(createAccountEmailPort(resendEnv).send(reset)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["TypeError", "TimeoutError"])(
    "sanitizes a %s and keeps the port available for retries",
    async (name) => {
      const sensitiveDetails = `${resendEnv.RESEND_API_KEY} ${reset.code}`;
      const failure =
        name === "TypeError"
          ? new TypeError(sensitiveDetails)
          : new DOMException(sensitiveDetails, name);
      vi.mocked(fetch).mockRejectedValueOnce(failure);
      const port = createAccountEmailPort(resendEnv);
      const delivery = port.send(reset);
      await expect(delivery).rejects.toEqual(new Error("Account email Resend delivery failed"));
      await expect(delivery).rejects.not.toHaveProperty("cause");
      expect(port.available).toBe(true);
      await expect(port.send(reset)).resolves.toBeUndefined();
    },
  );

  it.each([
    {},
    { RESEND_API_KEY: resendEnv.RESEND_API_KEY },
    { ACCOUNT_EMAIL_FROM: resendEnv.ACCOUNT_EMAIL_FROM },
    { ...resendEnv, RESEND_API_KEY: "" },
    { ...resendEnv, RESEND_API_KEY: " \t" },
    { ...resendEnv, RESEND_API_KEY: "test\r\nX-Injected:value" },
    { ...resendEnv, ACCOUNT_EMAIL_FROM: "" },
    { ...resendEnv, ACCOUNT_EMAIL_FROM: "junk" },
    { ...resendEnv, ACCOUNT_EMAIL_FROM: " <accounts@example.test>" },
    { ...resendEnv, ACCOUNT_EMAIL_FROM: "a@example.test,b@example.test" },
    { ...resendEnv, ACCOUNT_EMAIL_FROM: "Team\r\n <accounts@example.test>" },
  ])("falls back to relay or stays unavailable with unusable Resend settings %#", async (env) => {
    const unavailable = createAccountEmailPort({
      ...env,
      ...relayEnv,
      ACCOUNT_EMAIL_RELAY_URL: "http://relay.example.test",
    });
    expect(unavailable.available).toBe(false);
    await expect(unavailable.send(reset)).rejects.toThrow("Account email relay is unavailable");
    expect(fetch).not.toHaveBeenCalled();

    const relay = createAccountEmailPort({ ...env, ...relayEnv });
    expect(relay.available).toBe(true);
    await relay.send(reset);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL(relayEnv.ACCOUNT_EMAIL_RELAY_URL), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer test-relay-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(reset),
      signal: expect.any(AbortSignal),
    });
  });
});
