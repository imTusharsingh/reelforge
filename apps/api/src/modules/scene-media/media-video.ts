import {
  EmptyMediaResponse,
  VideoRouter,
  ProviderLimiter,
  reservationCents,
  secondsCost,
  type ClipArtifact,
  type MediaDeliveryFailure,
  type VideoGenPort as NativeVideoPort,
  type VideoOptions,
  type VideoRoutingState,
  type RecordVideoOutcome,
} from "@reelforge/ai-providers";
import { MediaValidationError } from "@reelforge/media";
import type { ShotSpec } from "@reelforge/contracts";
import {
  InvalidVideoFormat,
  ShotBillingFailure,
  ShotMediaFailure,
  type VideoGenPort,
  type VideoReceipt,
  type ShotBilling,
} from "../orchestration/video-run.handlers.js";
import type { Context, Run } from "../runs/runs.types.js";
import { StorageObjectNotFoundError } from "../asset/storage/storage.port.js";
import { MediaJobs, MediaChecksumMismatch } from "./media-jobs.js";
import { imageSurcharge, savedVideoPricing, videoPricingSchema } from "./media-prices.js";

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
      undefined, // V3 admits each rewrite separately.
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
  public async fetch(id: string, saved?: ClipArtifact, billing?: ShotBilling): Promise<Buffer> {
    const media = saved ?? (await this.fetchMedia(id, billing));
    let body: Buffer;
    try {
      await this.validateFormat(id, media, saved ? undefined : billing);
      body = await this.jobs.bytes(this.context, media).catch(this.mediaFailure(id));
    } catch (error) {
      const cause = error instanceof ShotMediaFailure ? error.cause : error;
      if (
        !saved ||
        !billing ||
        !(
          cause instanceof StorageObjectNotFoundError ||
          cause instanceof MediaChecksumMismatch ||
          error instanceof InvalidVideoFormat
        )
      )
        throw error;
      const receipt = await this.collectReceipt(id, billing.shot, billing);
      body = await this.jobs.bytes(this.context, receipt.media).catch(this.mediaFailure(id));
      await billing.record(receipt);
    }
    if (!this.options.extension) return body;
    if (!this.trim)
      throw new ShotMediaFailure(
        this.providerId,
        id,
        new Error("Extension tail extraction is not configured"),
      );
    return this.trim(body, this.options.extension.previousSeconds).catch(this.mediaFailure(id));
  }
  private mediaFailure(id: string): MediaDeliveryFailure {
    return (cause) => {
      if (cause instanceof MediaValidationError || cause instanceof EmptyMediaResponse)
        throw new InvalidVideoFormat(this.providerId, id, cause);
      throw new ShotMediaFailure(this.providerId, id, cause);
    };
  }
  private fetchMedia(id: string, billing?: ShotBilling): Promise<ClipArtifact> {
    return this.native.fetch(id, this.recordBilling(billing), this.mediaFailure(id));
  }
  private async validateFormat(
    id: string,
    media: ClipArtifact,
    billing?: ShotBilling,
  ): Promise<void> {
    if (
      media.mimeType !== "video/mp4" ||
      media.width !== 720 ||
      media.height !== 1280 ||
      media.fps !== 24
    ) {
      // Some ports supply billed seconds only on the fetched descriptor.
      if (billing && media.billedSeconds !== null)
        await billing.record(this.price(billing, media.billedSeconds, null));
      throw new InvalidVideoFormat(this.providerId, id);
    }
  }
  public collectionPricing(shot: ShotSpec): ReturnType<typeof savedVideoPricing> {
    const cap = this.native.capabilities();
    return videoPricingSchema.parse({
      modelId: cap.modelId,
      microUsdPerSecond: cap.pricePerSecond["720p"],
      inputImageMicroUsd:
        this.providerId === "xai"
          ? (shot.references.length + this.frameCount) * imageSurcharge()
          : 0,
    });
  }
  public async collectReceipt(
    id: string,
    shot: ShotSpec,
    billing?: ShotBilling,
  ): Promise<VideoReceipt & { media: ClipArtifact }> {
    savedVideoPricing(billing?.savedOutput);
    const media = await this.fetchMedia(id, billing);
    await this.validateFormat(id, media, billing);
    return this.price({ shot, savedOutput: billing?.savedOutput }, media.billedSeconds, media);
  }
  private recordBilling(billing?: ShotBilling): ((seconds: number) => Promise<void>) | undefined {
    if (billing) return (seconds) => billing.record(this.price(billing, seconds, null));
  }
  private price<T extends ClipArtifact | null>(
    billing: Pick<ShotBilling, "shot" | "savedOutput">,
    billedSeconds: number | null,
    media: T,
  ): VideoReceipt & { media: T } {
    try {
      const pricing = savedVideoPricing(billing.savedOutput);
      const seconds = billedSeconds ?? billing.shot.durationSeconds;
      const cost = secondsCost(seconds, pricing.microUsdPerSecond);
      return {
        media,
        costBasis: billedSeconds === null ? "RESERVATION" : "BILLED",
        seconds,
        providerDurationSeconds: media?.durationSeconds ?? null,
        costMinor: reservationCents({
          ...cost,
          microUsd: cost.microUsd + pricing.inputImageMicroUsd,
        }),
        modelId: pricing.modelId,
        promptVersion: "art-director:v2",
      };
    } catch (cause) {
      return ShotBillingFailure.rethrow(cause);
    }
  }
}
