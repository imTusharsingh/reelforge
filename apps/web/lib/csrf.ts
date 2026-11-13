const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function csrfTokenFromCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("reelforge_csrf="))
    ?.slice("reelforge_csrf=".length);
}

export function withCsrf(init: RequestInit = {}): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const token = csrfTokenFromCookie();
  if (UNSAFE.has(method) && token) headers.set("X-CSRF-Token", token);
  return { ...init, headers };
}

export async function ensureCsrfToken(): Promise<void> {
  const response = await fetch("/api/v1/auth/csrf", { credentials: "include" });
  if (!response.ok) throw new Error("Unable to initialize secure sign-in.");
}
