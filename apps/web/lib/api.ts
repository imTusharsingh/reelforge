export type WorkspaceRole = "OWNER" | "EDITOR" | "VIEWER";
export type Workspace = {
  id: string;
  name: string;
  archivedAt?: string | null;
  role: WorkspaceRole;
};
type CreatedWorkspace = Pick<Workspace, "id" | "name">;

export type AuthMe = {
  userId: string;
  email: string;
  displayName: string | null;
};

export type ChangePasswordResult = {
  ok: true;
  revokedSessions: number;
};

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;

  public constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type ResponseGuard<T> = (payload: unknown) => payload is T;

function isRecord(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null;
}

function isAuthResponse(payload: unknown): payload is { userId: string } {
  return isRecord(payload) && typeof payload.userId === "string" && payload.userId.length > 0;
}

function isCreatedWorkspace(payload: unknown): payload is CreatedWorkspace {
  return (
    isRecord(payload) &&
    typeof payload.id === "string" &&
    payload.id.length > 0 &&
    typeof payload.name === "string" &&
    payload.name.length > 0
  );
}

function isWorkspace(payload: unknown): payload is Workspace {
  return (
    isRecord(payload) &&
    typeof payload.id === "string" &&
    payload.id.length > 0 &&
    typeof payload.name === "string" &&
    payload.name.length > 0 &&
    (payload.archivedAt === undefined ||
      payload.archivedAt === null ||
      typeof payload.archivedAt === "string") &&
    (payload.role === "OWNER" || payload.role === "EDITOR" || payload.role === "VIEWER")
  );
}

function isWorkspaceList(payload: unknown): payload is Workspace[] {
  return Array.isArray(payload) && payload.every(isWorkspace);
}

function isLogoutResponse(payload: unknown): payload is { ok: true } {
  return isRecord(payload) && payload.ok === true;
}

function isAuthMe(payload: unknown): payload is AuthMe {
  return (
    isRecord(payload) &&
    typeof payload.userId === "string" &&
    payload.userId.length > 0 &&
    typeof payload.email === "string" &&
    (payload.displayName === null || typeof payload.displayName === "string")
  );
}

function isChangePasswordResult(payload: unknown): payload is ChangePasswordResult {
  return (
    isRecord(payload) &&
    payload.ok === true &&
    typeof payload.revokedSessions === "number" &&
    Number.isInteger(payload.revokedSessions) &&
    payload.revokedSessions >= 0
  );
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  guard: ResponseGuard<T>,
): Promise<T> {
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
    const record =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
    const code = record && typeof record.code === "string" ? record.code : undefined;
    const message =
      record && "message" in record
        ? String(record.message)
        : response.status === 401
          ? "Your session has expired. Sign in again."
          : response.status === 403
            ? "You do not have access to this workspace."
            : "The request could not be completed.";
    throw new ApiError(response.status, message, code);
  }
  if (!guard(payload)) throw new ApiError(502, "The service returned an invalid response.");
  return payload;
}

export const api = {
  login: (email: string, password: string): Promise<{ userId: string }> =>
    request(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      isAuthResponse,
    ),
  register: (email: string, password: string, displayName: string): Promise<{ userId: string }> =>
    request(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify({ email, password, displayName }),
      },
      isAuthResponse,
    ),
  logout: (): Promise<{ ok: true }> =>
    request("/auth/logout", { method: "POST" }, isLogoutResponse),
  listWorkspaces: (): Promise<Workspace[]> => request("/workspaces", undefined, isWorkspaceList),
  createWorkspace: (name: string): Promise<CreatedWorkspace> =>
    request("/workspaces", { method: "POST", body: JSON.stringify({ name }) }, isCreatedWorkspace),
  me: (): Promise<AuthMe> => request("/auth/me", undefined, isAuthMe),
  updateMe: (displayName: string): Promise<AuthMe> =>
    request("/auth/me", { method: "PATCH", body: JSON.stringify({ displayName }) }, isAuthMe),
  changePassword: (currentPassword: string, newPassword: string): Promise<ChangePasswordResult> =>
    request(
      "/auth/me/password",
      { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) },
      isChangePasswordResult,
    ),
};
