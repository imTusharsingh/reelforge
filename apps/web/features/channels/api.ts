import { canEdit, isRecord, type Channel, type RecordValue, type Role } from "./model";
export class ChannelApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChannelApiError";
  }
}
export type Shape = "channel" | "named" | "version" | "asset" | "snapshot" | "entity" | "record";
export function guardRecord(value: unknown, shape: Shape, workspaceId: string): RecordValue {
  if (!isRecord(value)) throw new ChannelApiError(502, "The service returned an invalid object.");
  if (value.workspaceId !== undefined && value.workspaceId !== workspaceId)
    throw new ChannelApiError(502, "The service returned data for another workspace.");
  if (shape !== "record" && (typeof value.id !== "string" || !value.id))
    throw new ChannelApiError(502, "The service returned an invalid identifier.");
  if ((shape === "named" || shape === "channel") && (typeof value.name !== "string" || !value.name))
    throw new ChannelApiError(502, "The service returned an invalid name.");
  if (
    shape === "channel" &&
    (value.workspaceId !== workspaceId ||
      !["ACTIVE", "PAUSED", "ARCHIVED"].includes(String(value.status)))
  )
    throw new ChannelApiError(502, "The service returned an invalid channel.");
  if (
    (shape === "version" || shape === "snapshot" || shape === "asset") &&
    (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1)
  )
    throw new ChannelApiError(502, "The service returned an invalid version.");
  if (
    shape === "asset" &&
    (typeof value.mediaType !== "string" || typeof value.status !== "string")
  )
    throw new ChannelApiError(502, "The service returned an invalid asset.");
  return value;
}
export class ChannelsClient {
  constructor(
    readonly workspaceId: string,
    readonly signal: AbortSignal,
    readonly role: Role = "UNKNOWN",
  ) {}
  async request(
    path: string,
    options: {
      method?: string;
      body?: RecordValue;
      list?: boolean;
      shape?: Shape;
      readOnly?: boolean;
    } = {},
  ): Promise<RecordValue | RecordValue[]> {
    this.signal.throwIfAborted();
    if (options.readOnly && !["config/resolve", "prompts/preview"].includes(path))
      throw new ChannelApiError(403, "This operation is not a read-only preview.");
    if (options.method && options.method !== "GET" && !options.readOnly && !canEdit(this.role))
      throw new ChannelApiError(403, "A verified owner or editor role is required.");
    let response: Response;
    try {
      response = await fetch(`/api/v1/workspaces/${encodeURIComponent(this.workspaceId)}/${path}`, {
        method: options.method ?? "GET",
        credentials: "include",
        signal: this.signal,
        headers: { "Content-Type": "application/json" },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      this.signal.throwIfAborted();
      throw new ChannelApiError(
        0,
        error instanceof Error && error.name === "AbortError"
          ? "Request cancelled."
          : "The service is unavailable. Check your connection and try again.",
      );
    }
    const data: unknown =
      response.status === 204 ? {} : await response.json().catch(() => undefined);
    this.signal.throwIfAborted();
    if (!response.ok) {
      const detail = isRecord(data) && typeof data.message === "string" ? data.message : "";
      const reason =
        response.status === 401
          ? "Your session expired. Sign out and sign in again."
          : response.status === 403
            ? "You do not have permission for this action."
            : response.status === 404
              ? "This item is unavailable in the selected workspace."
              : response.status === 409
                ? "This item changed or conflicts with its current state. Refresh before retrying."
                : "The request could not be completed.";
      throw new ChannelApiError(response.status, detail ? `${reason} ${detail}` : reason);
    }
    if (options.list) {
      if (!Array.isArray(data))
        throw new ChannelApiError(502, "The service returned an invalid list.");
      return data.map((v) => guardRecord(v, options.shape ?? "named", this.workspaceId));
    }
    const shape =
      options.shape ??
      (options.method &&
      options.method !== "GET" &&
      options.method !== "DELETE" &&
      !options.readOnly
        ? "entity"
        : "record");
    const value = guardRecord(data, shape, this.workspaceId);
    if (
      path === "config/resolve" &&
      (!isRecord(value.config) || !Array.isArray(value.layers) || !Array.isArray(value.locks))
    )
      throw new ChannelApiError(502, "The service returned invalid resolved configuration.");
    if (
      path === "prompts/preview" &&
      (!isRecord(value.config) || !isRecord(value.template) || !isRecord(value.bundle))
    )
      throw new ChannelApiError(502, "The service returned an invalid prompt preview.");
    if (/^channels\/[^/]+$/.test(path) && value.id !== decodeURIComponent(path.split("/")[1]!))
      throw new ChannelApiError(502, "The service returned a different channel.");
    return value;
  }
  async list(path: string, shape: Shape = "named"): Promise<RecordValue[]> {
    return (await this.request(path, { list: true, shape })) as RecordValue[];
  }
  async get(path: string, shape: Shape = "record"): Promise<RecordValue> {
    return (await this.request(path, { shape })) as RecordValue;
  }
  async channels(): Promise<Channel[]> {
    return (await this.list("channels", "channel")) as Channel[];
  }
  async channel(id: string): Promise<Channel> {
    return (await this.get(`channels/${encodeURIComponent(id)}`, "channel")) as Channel;
  }
}
export const segment = (value: unknown): string => encodeURIComponent(String(value));
