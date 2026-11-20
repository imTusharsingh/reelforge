import { z } from "zod";

export const ACCOUNT_EMAIL = Symbol("ACCOUNT_EMAIL");

export type EmailPurpose = "RESET_PASSWORD" | "CHANGE_EMAIL";
export interface AccountEmailPort {
  readonly available?: boolean;
  send(input: { to: string; purpose: EmailPurpose; code: string }): Promise<void>;
}

/** The deployment's mail relay renders the requested template and delivers it to the mailbox. */
function accountEmailRelay(env: NodeJS.ProcessEnv): AccountEmailPort {
  const url = env.ACCOUNT_EMAIL_RELAY_URL;
  const token = env.ACCOUNT_EMAIL_RELAY_TOKEN;
  const endpoint = URL.parse(url ?? "");
  const available =
    !!token && endpoint?.protocol === "https:" && !endpoint.username && !endpoint.password;
  return {
    available,
    async send(input): Promise<void> {
      if (!available || !endpoint) throw new Error("Account email relay is unavailable");
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Account email relay rejected delivery");
    },
  };
}

const emailAddress = z.email().max(254);
const subjects: Record<EmailPurpose, string> = {
  RESET_PASSWORD: "Reset your ReelForge password",
  CHANGE_EMAIL: "Confirm your ReelForge email change",
};
const directions: Record<EmailPurpose, string> = {
  RESET_PASSWORD: "Paste this one-time code into the password reset form:",
  CHANGE_EMAIL: "Paste this one-time code into the email change confirmation form:",
};

function resendFrom(value: string | undefined): string | undefined {
  if (!value || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return;
  const from = value.trim();
  const named = /^([^<>,;:"]+) +<([^<>]+)>$/u.exec(from);
  if (emailAddress.safeParse(from).success) return from;
  if (named?.[1]?.trim() && emailAddress.safeParse(named[2]).success) return from;
}

function accountEmailResend(apiKey: string, from: string): AccountEmailPort {
  return {
    available: true,
    async send({ to, purpose, code }): Promise<void> {
      const direction = directions[purpose];
      const escapedCode = code
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            from,
            to,
            subject: subjects[purpose],
            text: `${direction}\n\n${code}`,
            html: `<p>${direction}</p><p><strong>${escapedCode}</strong></p>`,
          }),
          signal: AbortSignal.timeout(5000),
        });
        // Delivery is determined by the HTTP status. Discard the body without retrying on cleanup errors.
        void response.body?.cancel().catch(() => undefined);
        if (response.ok) return;
      } catch {
        // Drop transport error details because they can contain credentials or message content.
        throw new Error("Account email Resend delivery failed");
      }
      throw new Error("Account email Resend rejected delivery");
    },
  };
}

export function createAccountEmailPort(env: NodeJS.ProcessEnv): AccountEmailPort {
  const apiKey = env.RESEND_API_KEY;
  const from = resendFrom(env.ACCOUNT_EMAIL_FROM);
  if (apiKey && !/[^A-Za-z0-9_-]/u.test(apiKey) && from) return accountEmailResend(apiKey, from);
  return accountEmailRelay(env);
}
