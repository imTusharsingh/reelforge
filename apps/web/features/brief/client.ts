import {
  ChannelBriefSchema,
  StoredChannelBriefSchema,
  ProviderCapabilitySchema,
  type ChannelBrief,
  type ProviderCapability,
} from "../../../../packages/contracts/src/foundations";
import {
  BriefInputSchema,
  type BriefInput,
} from "../../../../packages/contracts/src/channel-brief";
import { withCsrf } from "../../lib/csrf";

type Transport = typeof fetch;
export class UnsupportedNarrationLanguageError extends Error {
  public constructor() {
    super("This narration language isn’t supported. Choose another language, such as English.");
  }
}
export type KeyStatus = { gemini: boolean; xai: boolean };
export interface SetupPorts {
  keys(): Promise<KeyStatus>;
  saveKey(provider: "gemini" | "xai", key: string): Promise<void>;
  capabilities(): Promise<ProviderCapability[]>;
  queue(brief: ChannelBrief, idempotencyKey: string): Promise<{ id: string }>;
}
/** V2/V3 HTTP boundary. Tests supply a stub transport; production never fabricates success. */
export class BriefClient implements SetupPorts {
  public constructor(
    readonly workspaceId: string,
    private readonly transport: Transport = fetch.bind(globalThis),
  ) {}
  private root(): string {
    return `/workspaces/${encodeURIComponent(this.workspaceId)}`;
  }
  private async response(path: string, method = "GET", body?: unknown): Promise<Response> {
    const result = await this.transport(
      `/api/v1${path}`,
      withCsrf({
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    // Never surface arbitrary server response bodies: they could contain submitted secrets.
    if (!result.ok) {
      if (result.status === 400 || (result.status === 409 && path === "/runs")) {
        const payload: unknown = await result.json().catch(() => null);
        const code =
          typeof payload === "object" && payload !== null && "code" in payload
            ? payload.code
            : undefined;
        if (result.status === 400 && code === "INVALID_KEY")
          throw new Error("Enter a valid provider key.");
        if (result.status === 409 && code === "NARRATION_LANGUAGE_UNSUPPORTED")
          throw new UnsupportedNarrationLanguageError();
      }
      throw new Error(
        result.status === 403
          ? "Workspace access denied."
          : "The service is unavailable. Retry when it is ready.",
      );
    }
    return result;
  }
  private async json(path: string, method = "GET", body?: unknown): Promise<unknown> {
    return (await this.response(path, method, body)).json();
  }
  public async briefs(channelId: string): Promise<ChannelBrief[]> {
    const data = await this.json(`${this.root()}/channels/${encodeURIComponent(channelId)}/briefs`);
    if (!Array.isArray(data)) throw new Error("Invalid Brief response.");
    return data.map((item) => this.ownedBrief(StoredChannelBriefSchema.parse(item), channelId));
  }
  private ownedBrief(brief: ChannelBrief, channelId: string): ChannelBrief {
    if (brief.workspaceId !== this.workspaceId || brief.channelId !== channelId)
      throw new Error("Invalid Brief scope.");
    return brief;
  }
  public async save(channelId: string, input: BriefInput): Promise<ChannelBrief> {
    return this.ownedBrief(
      ChannelBriefSchema.parse(
        await this.json(
          `${this.root()}/channels/${encodeURIComponent(channelId)}/briefs`,
          "POST",
          BriefInputSchema.parse(input),
        ),
      ),
      channelId,
    );
  }
  public async eligibility(channelId: string): Promise<boolean> {
    const data = await this.json(
      `${this.root()}/channels/${encodeURIComponent(channelId)}/briefs/eligibility`,
    );
    if (
      typeof data !== "object" ||
      data === null ||
      !("approvedShorts" in data) ||
      !Number.isSafeInteger(data.approvedShorts) ||
      Number(data.approvedShorts) < 0
    )
      throw new Error("Invalid approval count.");
    return Number(data.approvedShorts) >= 10;
  }
  public async createChannel(name: string): Promise<string> {
    const data = await this.json(`${this.root()}/channels`, "POST", { name });
    if (
      typeof data !== "object" ||
      data === null ||
      !("id" in data) ||
      typeof data.id !== "string" ||
      !("workspaceId" in data) ||
      data.workspaceId !== this.workspaceId
    )
      throw new Error("Invalid channel response.");
    return data.id;
  }
  public async keys(): Promise<KeyStatus> {
    const data = await this.json(`${this.root()}/providers/keys`);
    if (
      typeof data !== "object" ||
      data === null ||
      !("gemini" in data) ||
      !("xai" in data) ||
      typeof data.gemini !== "boolean" ||
      typeof data.xai !== "boolean" ||
      Object.keys(data).length !== 2
    )
      throw new Error("Invalid key status.");
    return { gemini: data.gemini, xai: data.xai };
  }
  public async saveKey(provider: "gemini" | "xai", key: string): Promise<void> {
    if (!key.trim()) throw new Error("Enter a provider key.");
    await this.response(`${this.root()}/providers/${provider}/key`, "PUT", { key });
  }
  public async capabilities(): Promise<ProviderCapability[]> {
    const data = await this.json(`${this.root()}/providers/health`);
    if (!Array.isArray(data)) throw new Error("Invalid provider response.");
    return data.map((item) => {
      const capability = ProviderCapabilitySchema.parse(item);
      if (capability.workspaceId !== this.workspaceId) throw new Error("Invalid provider scope.");
      return capability;
    });
  }
  public async queue(brief: ChannelBrief, idempotencyKey: string): Promise<{ id: string }> {
    const run = await this.json("/runs", "POST", {
      workspaceId: this.workspaceId,
      channelBriefId: brief.id,
      idempotencyKey,
    });
    if (
      typeof run !== "object" ||
      run === null ||
      !("id" in run) ||
      typeof run.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(run.id)
    )
      throw new Error("Invalid run response.");
    return { id: run.id };
  }
}
