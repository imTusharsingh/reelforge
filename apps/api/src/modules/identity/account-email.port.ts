export const ACCOUNT_EMAIL = Symbol("ACCOUNT_EMAIL");

export type EmailPurpose = "RESET_PASSWORD" | "CHANGE_EMAIL";
export interface AccountEmailPort {
  send(input: { to: string; purpose: EmailPurpose; code: string }): Promise<void>;
}

/** The deployment's mail relay renders the requested template and delivers it to the mailbox. */
export function accountEmailRelay(env: NodeJS.ProcessEnv): AccountEmailPort {
  const url = env.ACCOUNT_EMAIL_RELAY_URL;
  const token = env.ACCOUNT_EMAIL_RELAY_TOKEN;
  return {
    async send(input): Promise<void> {
      if (!url || !token) throw new Error("Account email relay is unavailable");
      const endpoint = new URL(url);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
        throw new Error("Account email relay requires HTTPS");
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
