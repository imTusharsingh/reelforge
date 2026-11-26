import {
  ProviderFailure,
  SubmissionRefused,
  ProviderHttp,
  record,
  requiredString,
  type Json,
} from "./http.js";
import type {
  ArtifactStore,
  ClipArtifact,
  JobStatus,
  MediaDeliveryFailure,
  RecordBilledSeconds,
} from "./ports.js";

/** REST Interactions boundary. Callers persist the returned id before scheduling polls. */
export class Interactions {
  public constructor(
    private readonly http: ProviderHttp,
    private readonly store: ArtifactStore,
  ) {}

  public result(body: Json, key: string): Promise<Json> {
    return this.http.json("interactions", { ...body, background: false, store: false }, key);
  }

  public async submit(body: Json, idemKey: string): Promise<{ providerJobId: string }> {
    if (!idemKey.trim()) throw new ProviderFailure("INVALID", false);
    const response = await this.http.json(
      "interactions",
      { ...body, background: true, store: true },
      idemKey,
    );
    if (this.status(response) === "refused")
      throw new SubmissionRefused(
        typeof response.id === "string" && response.id.trim() ? response.id : null,
      );
    return { providerJobId: requiredString(response.id) };
  }

  public async poll(id: string, recordBilling?: RecordBilledSeconds): Promise<JobStatus> {
    const response = await this.get(id);
    const status = this.status(response);
    if (status === "succeeded" && recordBilling) {
      const seconds = this.billedSeconds(response);
      if (seconds !== null) await recordBilling(seconds);
    }
    return status;
  }

  public async fetch(
    id: string,
    kind: "video" | "image" | "audio",
    trimSeconds?: number,
    recordBilling?: RecordBilledSeconds,
    onMediaFailure?: MediaDeliveryFailure,
  ): Promise<ClipArtifact> {
    const response = await this.get(id);
    const status = this.status(response);
    if (status === "refused") throw new ProviderFailure("REFUSAL", true);
    if (status !== "succeeded") throw new ProviderFailure("INVALID", true);
    const billedSeconds = this.billedSeconds(response);
    if (billedSeconds !== null) await recordBilling?.(billedSeconds);
    const artifact = await this.download(response, kind, trimSeconds).catch(onMediaFailure);
    return { ...artifact, billedSeconds };
  }

  private async download(
    response: Json,
    kind: "video" | "image" | "audio",
    trimSeconds?: number,
  ): ReturnType<ArtifactStore["save"]> {
    const content = this.outputs(response)
      .filter((item) => item.type === kind)
      .at(-1);
    if (!content) throw new ProviderFailure("INVALID", true);
    const bytes =
      typeof content.uri === "string"
        ? await this.http.bytes(content.uri)
        : this.decode(requiredString(content.data));
    return this.store.save(bytes, requiredString(content.mime_type), trimSeconds);
  }
  private billedSeconds(response: Json): number | null {
    const seconds = response.usage === undefined ? null : record(response.usage).billed_seconds;
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  public async get(id: string): Promise<Json> {
    if (!id.trim()) throw new ProviderFailure("INVALID", false);
    return this.http.json(`interactions/${encodeURIComponent(id)}`);
  }

  public outputs(response: Json): Json[] {
    if (!Array.isArray(response.steps)) throw new ProviderFailure("INVALID", true);
    return response.steps
      .map(record)
      .filter((step) => step.type === "model_output")
      .flatMap((step) => {
        if (!Array.isArray(step.content)) throw new ProviderFailure("INVALID", true);
        return step.content.map(record);
      });
  }

  private status(response: Json): JobStatus {
    switch (response.status) {
      case "queued":
        return "queued";
      case "in_progress":
        return "running";
      case "completed":
        return "succeeded";
      case "refused":
        return "refused";
      case "failed": {
        const error = response.error === undefined ? {} : record(response.error);
        return error.code === "content_policy_violation" || error.code === "safety"
          ? "refused"
          : "failed";
      }
      case "cancelled":
        return "failed";
      default:
        throw new ProviderFailure("INVALID", true);
    }
  }

  private decode(encoded: string): Uint8Array {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
      throw new ProviderFailure("INVALID", true);
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
}
