export type Workspace = { id: string; name: string; archivedAt?: string | null };

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "The service is unavailable. Check your connection and try again.");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? String((payload as { message: unknown }).message)
        : response.status === 401
          ? "Your session has expired. Sign in again."
          : response.status === 403
            ? "You do not have access to this workspace."
            : "The request could not be completed.";
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

export const api = {
  login: (email: string, password: string): Promise<{ userId: string }> =>
    request<{ userId: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string, displayName: string): Promise<{ userId: string }> =>
    request<{ userId: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    }),
  logout: (): Promise<{ ok: true }> => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  listWorkspaces: (): Promise<Workspace[]> => request<Workspace[]>("/workspaces"),
  createWorkspace: (name: string): Promise<Workspace> =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
};
