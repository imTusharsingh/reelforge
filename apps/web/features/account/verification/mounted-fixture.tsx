import { useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { AuthWorkspace } from "../../../components/auth-workspace";
import { AccountScreen } from "../../../components/account-screen";
import { me, workspace } from "./fixtures";

const query = new URLSearchParams(location.search);
const mode = query.get("mode") ?? "account";
const calls: Array<{ path: string; method: string; body: unknown }> = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const path = url.split("/api/v1")[1] ?? url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ path, method, body });

  if (mode === "login") {
    return json({ message: "Unauthenticated" }, 401);
  }

  if (path === "/workspaces" && method === "GET") return json([workspace]);
  if (path === "/auth/me" && method === "GET") return json({ ...me, displayName: me.displayName });
  if (path === "/auth/me" && method === "PATCH") {
    return json({ ...me, displayName: String(body?.displayName ?? me.displayName) });
  }
  if (path === "/auth/me/password" && method === "POST") {
    if (mode === "password-401") {
      return json({ message: "Invalid credentials", code: "INVALID_CREDENTIALS" }, 401);
    }
    if (mode === "password-429") {
      return json(
        { message: "Too many attempts. Try again later.", code: "TOO_MANY_ATTEMPTS" },
        429,
      );
    }
    if (mode === "password-400") {
      return json({ message: "New password must differ from the current password." }, 400);
    }
    return json({ ok: true, revokedSessions: 2 });
  }
  if (path === "/auth/logout" && method === "POST") return json({ ok: true });
  return json({ message: `Unexpected ${method} ${path}` }, 404);
};

(window as unknown as { m22Fixture: { calls: typeof calls } }).m22Fixture = { calls };

function Fixture(): JSX.Element {
  const [ready] = useState(true);
  if (!ready) return <></>;
  if (mode === "login") {
    return <AuthWorkspace>{null}</AuthWorkspace>;
  }
  return (
    <AuthWorkspace>
      <AccountScreen />
    </AuthWorkspace>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
