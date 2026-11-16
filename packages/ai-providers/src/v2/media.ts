import { ProviderFailure, type Json } from "./http.js";
import { Interactions } from "./interactions.js";
import type {
  ClipArtifact,
  ImageGenPort,
  ImageSpec,
  JobStatus,
  MusicPort,
  MusicSpec,
  TtsPort,
  TtsSpec,
} from "./ports.js";

abstract class GeminiMedia {
  public constructor(
    protected readonly client: Interactions,
    protected readonly model: string,
    private readonly kind: "image" | "audio",
  ) {}
  public poll(id: string): Promise<JobStatus> {
    return this.client.poll(id);
  }
  public fetch(id: string, trimSeconds?: number): Promise<ClipArtifact> {
    return this.client.fetch(id, this.kind, trimSeconds);
  }
  protected send(input: Json, key: string): Promise<{ providerJobId: string }> {
    return this.client.submit({ model: this.model, ...input }, key);
  }
  protected nonempty(value: string): void {
    if (!value.trim()) throw new ProviderFailure("INVALID", false);
  }
}
export class NanoBanana extends GeminiMedia implements ImageGenPort {
  public constructor(client: Interactions, model: string) {
    super(client, model, "image");
  }
  public submit(spec: ImageSpec, key: string): Promise<{ providerJobId: string }> {
    this.nonempty(spec.prompt);
    if ((spec.references?.length ?? 0) > 6) throw new ProviderFailure("INVALID", false);
    return this.send(
      {
        input: [{ type: "text", text: spec.prompt }, ...(spec.references ?? [])],
        response_format: { type: "image", aspect_ratio: "9:16" },
      },
      key,
    );
  }
}
export class GeminiTts extends GeminiMedia implements TtsPort {
  public constructor(client: Interactions, model: string) {
    super(client, model, "audio");
  }
  public submit(spec: TtsSpec, key: string): Promise<{ providerJobId: string }> {
    this.nonempty(spec.text);
    this.nonempty(spec.voice);
    return this.send(
      {
        input: spec.text,
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: spec.voice }] },
      },
      key,
    );
  }
}
export class LyriaMusic extends GeminiMedia implements MusicPort {
  public constructor(client: Interactions, model: string) {
    super(client, model, "audio");
  }
  public submit(spec: MusicSpec, key: string): Promise<{ providerJobId: string }> {
    this.nonempty(spec.prompt);
    if (
      spec.instrumentalOnly !== true ||
      !Number.isFinite(spec.durationSeconds) ||
      spec.durationSeconds <= 0 ||
      spec.durationSeconds > 120
    )
      throw new ProviderFailure("INVALID", false);
    return this.send(
      {
        input: `Instrumental only. No singing, speech, lyrics or artist imitation. ${spec.prompt}`,
        response_format: { type: "audio" },
      },
      key,
    );
  }
  public override fetch(id: string, trimSeconds?: number): Promise<ClipArtifact> {
    if (
      trimSeconds === undefined ||
      !Number.isFinite(trimSeconds) ||
      trimSeconds <= 0 ||
      trimSeconds > 120
    )
      throw new ProviderFailure("INVALID", false);
    return super.fetch(id, trimSeconds);
  }
}
