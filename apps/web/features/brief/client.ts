import {
  ChannelBriefSchema,
  ProviderCapabilitySchema,
  VideoRunSchema,
  type ChannelBrief,
  type ProviderCapability,
  type VideoRun,
} from "../../../../packages/contracts/src/foundations";
import {
  BriefInputSchema,
  type BriefInput,
} from "../../../../packages/contracts/src/channel-brief";
import { withCsrf } from "../../lib/csrf";

type Transport = typeof fetch;
export type KeyStatus = { gemini: boolean; xai: boolean };
export interface SetupPorts {
  keys(): Promise<KeyStatus>;
  saveKey(provider: "gemini" | "xai", key: string): Promise<void>;
  capabilities(): Promise<ProviderCapability[]>;
  queue(brief: ChannelBrief, idempotencyKey: string): Promise<VideoRun>;
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
    if (!result.ok)
      throw new Error(
        result.status === 403
          ? "Workspace access denied."
          : "The service is unavailable. Retry when it is ready.",
      );
    return result;
  }
  private async json(path: string, method = "GET", body?: unknown): Promise<unknown> {
    return (await this.response(path, method, body)).json();
  }
  public async briefs(channelId: string): Promise<ChannelBrief[]> {
    const data = await this.json(`${this.root()}/channels/${encodeURIComponent(channelId)}/briefs`);
    if (!Array.isArray(data)) throw new Error("Invalid Brief response.");
    return data.map((item) => this.ownedBrief(item, channelId));
  }
  private ownedBrief(value: unknown, channelId: string): ChannelBrief {
    const brief = ChannelBriefSchema.parse(value);
    if (brief.workspaceId !== this.workspaceId || brief.channelId !== channelId)
      throw new Error("Invalid Brief scope.");
    return brief;
  }
  public async save(channelId: string, input: BriefInput): Promise<ChannelBrief> {
    return this.ownedBrief(
      await this.json(
        `${this.root()}/channels/${encodeURIComponent(channelId)}/briefs`,
        "POST",
        BriefInputSchema.parse(input),
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
    const data = await this.json(`${this.root()}/provider-keys`);
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
    await this.response(`${this.root()}/provider-keys/${provider}`, "PUT", { key: key.trim() });
  }
  public async capabilities(): Promise<ProviderCapability[]> {
    const data = await this.json(`${this.root()}/providers/capabilities`);
    if (!Array.isArray(data)) throw new Error("Invalid provider response.");
    return data.map((item) => {
      const capability = ProviderCapabilitySchema.parse(item);
      if (capability.workspaceId !== this.workspaceId) throw new Error("Invalid provider scope.");
      return capability;
    });
  }
  public async queue(brief: ChannelBrief, idempotencyKey: string): Promise<VideoRun> {
    const run = VideoRunSchema.parse(
      await this.json("/runs", "POST", {
        workspaceId: this.workspaceId,
        channelId: brief.channelId,
        channelBriefId: brief.id,
        channelBriefVersion: brief.version,
        idempotencyKey,
      }),
    );
    if (
      run.workspaceId !== this.workspaceId ||
      run.channelId !== brief.channelId ||
      run.channelBriefId !== brief.id ||
      run.channelBriefVersion !== brief.version
    )
      throw new Error("Invalid run scope.");
    return run;
  }
}
