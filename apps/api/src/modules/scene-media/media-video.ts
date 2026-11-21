import {
  ProviderFailure,
  VideoRouter,
  ProviderLimiter,
  reservationCents,
  secondsCost,
  type ClipArtifact,
  type VideoGenPort as NativeVideoPort,
  type VideoOptions,
  type VideoRoutingState,
  type RecordVideoOutcome,
} from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
import type {
  VideoGenPort,
  VideoReceipt,
  ShotBilling,
} from "../orchestration/video-run.handlers.js";
import type { Context, Run } from "../runs/runs.types.js";
import { MediaJobs } from "./media-jobs.js";
import { imageSurcharge } from "./media-prices.js";
/** A V2 router dispatch under V3's already-reserved envelope/ledger, with no second M18 reservation. */
export class RoutedMediaVideo implements VideoGenPort {
  public readonly providerId: string;
  public readonly modelId: string;
  public constructor(
    private readonly native: NativeVideoPort,
    private readonly jobs: MediaJobs,
    private readonly context: Context,
    _run: Run,
    private readonly options: VideoOptions = {},
    private readonly limiter: ProviderLimiter = new ProviderLimiter(),
    private readonly trim?: (body: Buffer, from: number) => Promise<Buffer>,
    private readonly validateKey?: () => void,
    private readonly videoState?: VideoRoutingState,
    private readonly recordOutcome?: RecordVideoOutcome,
    private readonly frameCount = Number(!!options.firstFrame) + Number(!!options.lastFrame),
  ) {
    void _run;
    this.providerId = native.capabilities().providerId;
    this.modelId = native.capabilities().modelId;
  }
  public assertKey(): void {
    this.validateKey?.();
  }
  public estimate(shot: ShotSpec): number {
    const estimate = this.native.estimate(shot);
    return reservationCents({
      ...estimate,
      microUsd:
        estimate.microUsd + (this.providerId === "xai" ? this.frameCount * imageSurcharge() : 0),
    });
  }
  public async submit(shot: ShotSpec, key: string): Promise<{ providerJobId: string }> {
    const router = new VideoRouter(
      [{ port: this.native, tier: 0 }],
      {
        submit: (port, spec, id): Promise<{ providerJobId: string }> =>
          this.limiter.run(
            port.estimate(spec),
            () => port.submit(spec, id, this.options),
            port.capabilities().providerId === "gemini",
          ),
        allowFallback: async (): Promise<void> => {
          throw new Error("V3 must re-estimate the envelope before fallback");
        },
      },
      async (): Promise<never> => {
        throw new ProviderFailure("NEEDS_HUMAN", true);
      },
      Date.now,
      this.videoState,
      this.recordOutcome,
    );
    const job = await router.submit(shot, key, [this.providerId]);
    return { providerJobId: job.providerJobId };
  }
  public async reconcile(): Promise<null> {
    return null;
  }
  public poll(id: string, billing?: ShotBilling): ReturnType<NativeVideoPort["poll"]> {
    return this.native.poll(id, this.recordBilling(billing));
  }
  public async fetch(id: string, saved?: ClipArtifact): Promise<Buffer> {
    const media = saved ?? (await this.native.fetch(id));
    if (
      media.mimeType !== "video/mp4" ||
      media.width !== 720 ||
      media.height !== 1280 ||
      media.fps !== 24
    )
      throw new Error("Provider returned invalid 720p video");
    const body = await this.jobs.bytes(this.context, media);
    if (!this.options.extension) return body;
    if (!this.trim) throw new Error("Extension tail extraction is not configured");
    return this.trim(body, this.options.extension.previousSeconds);
  }
  public async collectReceipt(
    id: string,
    shot: ShotSpec,
    billing?: ShotBilling,
  ): Promise<VideoReceipt> {
    const media = await this.native.fetch(id, this.recordBilling(billing));
    return this.price(shot, media.billedSeconds ?? shot.durationSeconds, media);
  }
  private recordBilling(billing?: ShotBilling): ((seconds: number) => Promise<void>) | undefined {
    if (billing) return (seconds) => billing.record(this.price(billing.shot, seconds, null));
  }
  private price(shot: ShotSpec, seconds: number, media: ClipArtifact | null): VideoReceipt {
    const cost = secondsCost(seconds, this.native.capabilities().pricePerSecond["720p"]!);
    const images = shot.references.length + this.frameCount;
    return {
      media,
      seconds,
      providerDurationSeconds: media?.durationSeconds ?? null,
      costMinor: reservationCents({
        ...cost,
        microUsd: cost.microUsd + (this.providerId === "xai" ? images * imageSurcharge() : 0),
      }),
      modelId: this.native.capabilities().modelId,
      promptVersion: "art-director:v2",
    };
  }
}
