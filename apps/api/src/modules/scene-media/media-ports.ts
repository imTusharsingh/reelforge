import { Injectable } from "@nestjs/common";
import { ProviderLimiter } from "@reelforge/ai-providers";
import type { MediaInput, ReferenceResolver } from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
import { ProvidersRuntime } from "../openai/providers.runtime.js";
import { AssetService } from "../asset/asset.service.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import type { Context } from "../runs/runs.types.js";
import { MediaAccess } from "./media-access.js";
import { MediaJobs } from "./media-jobs.js";
@Injectable()
export class MediaPorts {
  private readonly limiters = new Map<string, ProviderLimiter>();
  public limiter(workspaceId: string, providerId: string): ProviderLimiter {
    const key = `${workspaceId}:${providerId}`;
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new ProviderLimiter();
      this.limiters.set(key, limiter);
    }
    return limiter;
  }
  public constructor(
    private readonly access: MediaAccess,
    private readonly providers: ProvidersRuntime,
    private readonly jobs: MediaJobs,
  ) {}
  public async references(
    context: Context,
    shot: Pick<ShotSpec, "references">,
  ): Promise<MediaInput[]> {
    const library = this.access.modules.get(ReferenceLibraryService, { strict: false });
    const assets = this.access.modules.get(AssetService, { strict: false });
    const refs = await library.resolve(context, shot.references);
    return Promise.all(
      refs.map(async (ref): Promise<MediaInput> => {
        if (!ref.assetId || !ref.assetVersion)
          throw new Error("Reference must pin an M04 asset version");
        const asset = await assets.getReference(context, {
          assetId: ref.assetId,
          version: ref.assetVersion,
        });
        if (!asset.mediaType.startsWith("image/") || asset.checksumSha256 !== ref.checksumSha256)
          throw new Error("Pinned reference integrity mismatch");
        const bytes = await this.jobs.bytes(context, asset);
        return { type: "image", mime_type: asset.mediaType, data: bytes.toString("base64") };
      }),
    );
  }
  public async get(
    context: Context,
    videoShot?: ShotSpec,
  ): Promise<Awaited<ReturnType<ProvidersRuntime["ports"]>>> {
    // Video ports resolve these immediately when they start their HTTP request under the run lock.
    // Resolve storage and database references before paid dispatch admission.
    const prepared = videoShot && {
      key: JSON.stringify(videoShot.references),
      media: await this.references(context, videoShot),
    };
    const references: ReferenceResolver = {
      resolve: async (shot): Promise<MediaInput[]> => {
        if (!prepared) return this.references(context, shot);
        if (JSON.stringify(shot.references) !== prepared.key)
          throw new Error("Video references changed after preparation");
        return prepared.media;
      },
    };
    const ports = await this.providers.ports(context, references);
    if (ports.omni.capabilities().health === "NOT_CONFIGURED")
      throw new Error("Gemini media credentials are not configured");
    return ports;
  }
}
