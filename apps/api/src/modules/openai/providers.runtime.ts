import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  capabilityCatalog,
  providerModels,
  ProviderHttp,
  Interactions,
  OmniVideo,
  GrokVideo,
  NanoBanana,
  GeminiText,
  GeminiTts,
  LyriaMusic,
  ProviderLimiter,
  VideoRouter,
  type ReferenceResolver,
  type Money,
  type VideoGenPort,
  type VideoRoutingState,
  type RecordVideoOutcome,
} from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import { ProviderArtifacts } from "./provider-artifacts.js";
import { ProviderKeys, type Vendor } from "./provider-keys.js";
import { ProviderVideoHealth } from "./provider-video-health.js";
import { ProviderLedger } from "./provider-ledger.js";

@Injectable()
export class ProvidersRuntime {
  public videoState(workspaceId: string): Promise<VideoRoutingState> {
    return this.health.state(workspaceId);
  }

  public videoOutcome(workspaceId: string): RecordVideoOutcome {
    return (providerId, outcome): Promise<void> =>
      this.health.record(workspaceId, providerId, outcome);
  }

  private readonly limiters = new Map<string, ProviderLimiter>();
  public constructor(
    private readonly keys: ProviderKeys,
    private readonly ledger: ProviderLedger,
    private readonly health: ProviderVideoHealth,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}
  public async ports(
    context: WorkspaceContext,
    references: ReferenceResolver,
  ): Promise<{
    assertKey: (vendor: Vendor) => void;
    omni: OmniVideo;
    grok: GrokVideo;
    image: NanoBanana;
    text: GeminiText;
    tts: GeminiTts;
    music: LyriaMusic;
  }> {
    const models = providerModels(process.env);
    const gemini = await this.keys.resolve(context, "gemini");
    const xai = await this.keys.resolve(context, "xai");
    const catalog = capabilityCatalog(context.workspaceId, models, {
      gemini: !!gemini,
      xai: !!xai,
    });
    const store = new ProviderArtifacts(this.storage, context.workspaceId);
    const http = {
      gemini: new ProviderHttp(gemini ?? "", "gemini"),
      xai: new ProviderHttp(xai ?? "", "xai"),
    };
    const client = new Interactions(http.gemini, store);
    return {
      assertKey: (vendor): void => http[vendor].assertKey(),
      omni: new OmniVideo(client, catalog[0]!, references),
      grok: new GrokVideo(http.xai, store, catalog[5]!, references),
      image: new NanoBanana(client, models.image),
      text: new GeminiText(client, models.text),
      tts: new GeminiTts(client, models.tts),
      music: new LyriaMusic(client, models.music),
    };
  }
  public async router(
    context: WorkspaceContext,
    channelId: string | null,
    references: ReferenceResolver,
    rewrite: (spec: ShotSpec) => Promise<ShotSpec>,
    allowFallback: (providerId: string, estimate: Money) => Promise<void>,
  ): Promise<VideoRouter> {
    const ports = await this.ports(context, references);
    return new VideoRouter(
      [
        { port: ports.omni, tier: 0 },
        { port: ports.grok, tier: 1 },
      ],
      {
        submit: async (port, spec, key): Promise<{ providerJobId: string }> => {
          if (spec.workspaceId !== context.workspaceId)
            throw new Error("Cross-workspace provider dispatch rejected");
          ports.assertKey(port === ports.omni ? "gemini" : "xai");
          return this.limiter(port).run(
            port.estimate(spec),
            () => this.ledger.submit(port, spec, correlation(key), channelId, key),
            port.capabilities().providerId === "gemini",
          );
        },
        allowFallback,
      },
      rewrite,
      Date.now,
      await this.videoState(context.workspaceId),
      this.videoOutcome(context.workspaceId),
    );
  }
  public async reconcile(
    workspaceId: string,
    key: string,
    port: VideoGenPort,
    providerJobId: string,
  ): Promise<void> {
    await this.ledger.finish(workspaceId, correlation(key), port, await port.fetch(providerJobId));
  }
  private limiter(port: VideoGenPort): ProviderLimiter {
    const id = port.capabilities().providerId;
    let limiter = this.limiters.get(id);
    if (!limiter) {
      limiter = new ProviderLimiter();
      this.limiters.set(id, limiter);
    }
    return limiter;
  }
}
function correlation(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
