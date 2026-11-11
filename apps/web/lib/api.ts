export type Workspace = { id: string; name: string; archivedAt?: string | null };

export type ChannelStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";
export type Channel = {
  id: string;
  workspaceId: string;
  name: string;
  status: ChannelStatus;
  handle?: string | null;
  description?: string | null;
  niche?: string | null;
  language?: string | null;
  audience?: string | null;
  timezone?: string | null;
  [key: string]: unknown;
};
export type ApiRecord = Record<string, unknown>;

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ResponseGuard<T> = (payload: unknown) => payload is T;

function isRecord(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null;
}

function isAuthResponse(payload: unknown): payload is { userId: string } {
  return isRecord(payload) && typeof payload.userId === "string" && payload.userId.length > 0;
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
      typeof payload.archivedAt === "string")
  );
}

function isWorkspaceList(payload: unknown): payload is Workspace[] {
  return Array.isArray(payload) && payload.every(isWorkspace);
}

function isLogoutResponse(payload: unknown): payload is { ok: true } {
  return isRecord(payload) && payload.ok === true;
}

function isChannel(payload: unknown): payload is Channel {
  return (
    isRecord(payload) &&
    typeof payload.id === "string" &&
    typeof payload.workspaceId === "string" &&
    typeof payload.name === "string" &&
    (payload.status === "ACTIVE" || payload.status === "PAUSED" || payload.status === "ARCHIVED")
  );
}

function isRecordList(payload: unknown): payload is ApiRecord[] {
  return Array.isArray(payload) && payload.every(isRecord);
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
  createWorkspace: (name: string): Promise<Workspace> =>
    request("/workspaces", { method: "POST", body: JSON.stringify({ name }) }, isWorkspace),
  listChannels: (workspaceId: string): Promise<Channel[]> =>
    request(
      `/workspaces/${workspaceId}/channels`,
      undefined,
      (payload): payload is Channel[] => Array.isArray(payload) && payload.every(isChannel),
    ),
  getChannel: (workspaceId: string, channelId: string): Promise<Channel> =>
    request(`/workspaces/${workspaceId}/channels/${channelId}`, undefined, isChannel),
  createChannel: (workspaceId: string, input: ApiRecord): Promise<Channel> =>
    request(
      `/workspaces/${workspaceId}/channels`,
      { method: "POST", body: JSON.stringify(input) },
      isChannel,
    ),
  updateChannel: (workspaceId: string, channelId: string, input: ApiRecord): Promise<Channel> =>
    request(
      `/workspaces/${workspaceId}/channels/${channelId}`,
      { method: "PATCH", body: JSON.stringify(input) },
      isChannel,
    ),
  setChannelStatus: (
    workspaceId: string,
    channelId: string,
    status: ChannelStatus,
  ): Promise<Channel> =>
    request(
      `/workspaces/${workspaceId}/channels/${channelId}/status`,
      { method: "POST", body: JSON.stringify({ status }) },
      isChannel,
    ),
  listChannelSnapshots: (workspaceId: string, channelId: string): Promise<ApiRecord[]> =>
    request(`/workspaces/${workspaceId}/channels/${channelId}/snapshots`, undefined, isRecordList),
  listGenres: (workspaceId: string): Promise<ApiRecord[]> =>
    request(`/workspaces/${workspaceId}/genres`, undefined, isRecordList),
  createGenre: (workspaceId: string, input: ApiRecord): Promise<ApiRecord> =>
    request(
      `/workspaces/${workspaceId}/genres`,
      { method: "POST", body: JSON.stringify(input) },
      isRecord,
    ),
  listSeries: (workspaceId: string, channelId: string): Promise<ApiRecord[]> =>
    request(`/workspaces/${workspaceId}/channels/${channelId}/series`, undefined, isRecordList),
  createSeries: (workspaceId: string, channelId: string, input: ApiRecord): Promise<ApiRecord> =>
    request(
      `/workspaces/${workspaceId}/channels/${channelId}/series`,
      { method: "POST", body: JSON.stringify(input) },
      isRecord,
    ),
  listCharacters: (workspaceId: string): Promise<ApiRecord[]> =>
    request(`/workspaces/${workspaceId}/characters`, undefined, isRecordList),
  createCharacter: (workspaceId: string, input: ApiRecord): Promise<ApiRecord> =>
    request(
      `/workspaces/${workspaceId}/characters`,
      { method: "POST", body: JSON.stringify(input) },
      isRecord,
    ),
  publishCharacter: (workspaceId: string, characterId: string): Promise<ApiRecord> =>
    request(
      `/workspaces/${workspaceId}/characters/${characterId}/publish`,
      { method: "POST" },
      isRecord,
    ),
  listAssets: (workspaceId: string): Promise<ApiRecord[]> =>
    request(`/workspaces/${workspaceId}/assets`, undefined, isRecordList),
  getWorkspaceConfig: (workspaceId: string): Promise<ApiRecord> =>
    request(`/workspaces/${workspaceId}/config`, undefined, isRecord),
  listConfigSnapshots: (workspaceId: string): Promise<ApiRecord[]> =>
    request(`/workspaces/${workspaceId}/config/generation-snapshots`, undefined, isRecordList),
  listPromptTemplates: (workspaceId: string): Promise<ApiRecord[]> =>
    request(`/workspaces/${workspaceId}/prompts/templates`, undefined, isRecordList),
};
