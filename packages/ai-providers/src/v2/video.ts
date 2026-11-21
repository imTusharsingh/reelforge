import { ShotSpecSchema, type ProviderCapability, type ShotSpec } from "@reelforge/contracts";
import { ProviderFailure, ProviderHttp, record, requiredString } from "./http.js";
import { Interactions } from "./interactions.js";
import { secondsCost } from "./money.js";
import type {
  ArtifactStore,
  ClipArtifact,
  JobStatus,
  RecordBilledSeconds,
  Money,
  ReferenceResolver,
  VideoGenPort,
  VideoOptions,
} from "./ports.js";

export class OmniVideo implements VideoGenPort {
  public constructor(
    private readonly client: Interactions,
    private readonly capability: ProviderCapability,
    private readonly references: ReferenceResolver,
  ) {}
  public capabilities(): ProviderCapability {
    return this.capability;
  }
  public estimate(spec: ShotSpec): Money {
    this.validate(spec);
    return secondsCost(spec.durationSeconds, this.capability.pricePerSecond["720p"]!);
  }
  public async submit(
    spec: ShotSpec,
    idemKey: string,
    options: VideoOptions = {},
  ): Promise<{ providerJobId: string }> {
    this.validate(spec);
    const references = await this.references.resolve(spec);
    if (references.length > this.capability.maxReferenceImages)
      throw new ProviderFailure("INVALID", false);
    if (spec.firstFrameFrom && !options.firstFrame) throw new ProviderFailure("INVALID", false);
    if (
      options.extension &&
      (spec.durationSeconds > 10 ||
        options.extension.previousSeconds + spec.durationSeconds > 30 ||
        options.extension.previousSeconds <= 0)
    )
      throw new ProviderFailure("INVALID", false);
    return this.client.submit(
      {
        model: this.capability.modelId,
        input: [
          ...references,
          ...(options.firstFrame ? [options.firstFrame] : []),
          ...(options.lastFrame ? [options.lastFrame] : []),
          {
            type: "text",
            text: `${spec.keyframePrompt}\n${spec.motionPrompt}\n${spec.negativePrompt}`,
          },
        ],
        response_format: {
          type: "video",
          delivery: "uri",
          duration: `${spec.durationSeconds}s`,
          aspect_ratio: "9:16",
          resolution: "720p",
        },
        ...(spec.seed === null ? {} : { generation_config: { seed: spec.seed } }),
        ...(options.extension ? { previous_interaction_id: options.extension.providerJobId } : {}),
      },
      idemKey,
    );
  }
  public poll(id: string, recordBilling?: RecordBilledSeconds): Promise<JobStatus> {
    return this.client.poll(id, recordBilling);
  }
  public fetch(id: string, recordBilling?: RecordBilledSeconds): Promise<ClipArtifact> {
    return this.client.fetch(id, "video", undefined, recordBilling);
  }
  private validate(spec: ShotSpec): void {
    if (
      !ShotSpecSchema.safeParse(spec).success ||
      !Number.isInteger(spec.durationSeconds) ||
      spec.fps !== 24 ||
      this.capability.pricePerSecond["720p"] === null
    )
      throw new ProviderFailure("INVALID", false);
  }
}

export class GrokVideo implements VideoGenPort {
  public constructor(
    private readonly http: ProviderHttp,
    private readonly store: ArtifactStore,
    private readonly capability: ProviderCapability,
    private readonly references: ReferenceResolver,
  ) {}
  public capabilities(): ProviderCapability {
    return this.capability;
  }
  public estimate(spec: ShotSpec): Money {
    this.validate(spec);
    const cost = secondsCost(spec.durationSeconds, this.capability.pricePerSecond["720p"]!);
    return { ...cost, microUsd: cost.microUsd + spec.references.length * 10000 };
  }
  public async submit(
    spec: ShotSpec,
    idemKey: string,
    options: VideoOptions = {},
  ): Promise<{ providerJobId: string }> {
    this.validate(spec);
    if (!idemKey.trim() || options.extension || (spec.firstFrameFrom && !options.firstFrame))
      throw new ProviderFailure("INVALID", false);
    const refs = await this.references.resolve(spec);
    if (refs.length > 14) throw new ProviderFailure("INVALID", false);
    const url = (media: (typeof refs)[number]): string =>
      media.uri ?? `data:${media.mime_type};base64,${requiredString(media.data)}`;
    const response = await this.http.json(
      "videos/generations",
      {
        model: this.capability.modelId,
        prompt: spec.motionPrompt,
        duration: spec.durationSeconds,
        aspect_ratio: "9:16",
        resolution: "720p",
        ...(refs.length ? { reference_images: refs.map((ref) => ({ url: url(ref) })) } : {}),
        ...(options.firstFrame ? { image: { url: url(options.firstFrame) } } : {}),
        ...(options.lastFrame ? { last_frame: { url: url(options.lastFrame) } } : {}),
      },
      idemKey,
    );
    return { providerJobId: requiredString(response.request_id) };
  }
  public async poll(id: string, recordBilling?: RecordBilledSeconds): Promise<JobStatus> {
    const response = await this.get(id);
    if (response.status === "pending") return "running";
    if (response.status === "failed") return "failed";
    if (response.status === "done") {
      const video = record(response.video);
      if (video.respect_moderation === false) return "refused";
      const seconds = video.duration;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)
        await recordBilling?.(seconds);
      return "succeeded";
    }
    throw new ProviderFailure("INVALID", true);
  }
  public async fetch(id: string, recordBilling?: RecordBilledSeconds): Promise<ClipArtifact> {
    const response = await this.get(id);
    if (response.status !== "done") throw new ProviderFailure("INVALID", true);
    const video = record(response.video);
    if (video.respect_moderation === false) throw new ProviderFailure("REFUSAL", true);
    const seconds = video.duration;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
      throw new ProviderFailure("INVALID", true);
    await recordBilling?.(seconds);
    const body = await this.http.bytes(requiredString(video.url));
    return { ...(await this.store.save(body, "video/mp4")), billedSeconds: seconds };
  }
  private get(id: string): Promise<Record<string, unknown>> {
    if (!id.trim()) throw new ProviderFailure("INVALID", false);
    return this.http.json(`videos/${encodeURIComponent(id)}`);
  }
  private validate(spec: ShotSpec): void {
    if (
      !ShotSpecSchema.safeParse(spec).success ||
      spec.fps !== 24 ||
      this.capability.pricePerSecond["720p"] === null
    )
      throw new ProviderFailure("INVALID", false);
  }
}
