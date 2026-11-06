import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { canonicalRenderFingerprint } from "@reelforge/media";
import { duration } from "./composition.validation.js";
import type { RenderArtifactView, RenderCompositionInput } from "./composition.types.js";
import type { RenderedArtifact } from "./composition.engine.js";

export interface RenderManifest {
  schemaVersion: "1.0";
  jobId: string;
  title: string;
  renderSeed: string;
  renderProfile: RenderCompositionInput["profile"];
  sourceMediaPackage: RenderCompositionInput["sourceMediaPackage"];
  pinnedInputs: Pick<RenderCompositionInput, "scenes" | "audio" | "coverFrames">;
  video: Readonly<{
    filename: "final.mp4";
    mediaType: "video/mp4";
    byteSize: number;
    checksumSha256: string;
    durationMs: number;
    artifactId?: string;
    objectKey?: string;
  }>;
  artifactOrder: readonly ("VIDEO" | "COVER" | "MANIFEST")[];
  covers?: readonly Readonly<{
    artifactId: string;
    objectKey: string;
    checksumSha256: string;
    byteSize: number;
    selectedFrame: RenderCompositionInput["coverFrames"][number];
  }>[];
}

export function validateEngineManifest(
  bytes: Buffer,
  input: RenderCompositionInput,
  jobId: string,
  video: RenderedArtifact,
  covers: readonly RenderedArtifact[],
): RenderManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new BadRequestException("Render manifest is not valid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new BadRequestException("Render manifest must be an object");
  const value = parsed as Partial<RenderManifest>;
  if (
    value.schemaVersion !== "1.0" ||
    value.jobId !== jobId ||
    value.title !== input.title ||
    value.renderSeed !== input.renderSeed ||
    canonicalRenderFingerprint(value.renderProfile) !== canonicalRenderFingerprint(input.profile) ||
    canonicalRenderFingerprint(value.sourceMediaPackage) !==
      canonicalRenderFingerprint(input.sourceMediaPackage) ||
    canonicalRenderFingerprint(value.pinnedInputs) !==
      canonicalRenderFingerprint({
        scenes: input.scenes,
        audio: input.audio,
        coverFrames: input.coverFrames,
      })
  )
    throw new BadRequestException("Render manifest does not match the pinned job and input");
  const media = value.video;
  if (
    !media ||
    media.filename !== "final.mp4" ||
    media.mediaType !== "video/mp4" ||
    media.byteSize !== video.body.length ||
    media.checksumSha256 !== createHash("sha256").update(video.body).digest("hex") ||
    media.durationMs !== video.durationMs ||
    Math.abs(media.durationMs - duration(input)) >= 51
  )
    throw new BadRequestException(
      "Render manifest does not match validated video bytes and duration",
    );
  if (
    canonicalRenderFingerprint(value.artifactOrder) !==
    canonicalRenderFingerprint(["VIDEO", ...input.coverFrames.map(() => "COVER"), "MANIFEST"])
  )
    throw new BadRequestException("Render manifest artifact order is invalid");
  covers.forEach((cover, index) => {
    if (
      canonicalRenderFingerprint(cover.selectedFrame) !==
      canonicalRenderFingerprint(input.coverFrames[index])
    )
      throw new BadRequestException("Cover artifact does not match its pinned selected frame");
  });
  return value as RenderManifest;
}

export function validateStoredManifest(
  bytes: Buffer,
  jobId: string,
  input: RenderCompositionInput,
  artifacts: readonly RenderArtifactView[],
): RenderManifest {
  // Validate object checksum/digest independently of the end-user supplied request.
  const manifest = artifacts.find((artifact) => artifact.kind === "MANIFEST");
  if (
    !manifest ||
    manifest.byteSize !== bytes.length ||
    manifest.checksumSha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw new BadRequestException("Stored manifest checksum or byte size mismatch");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new BadRequestException("Stored render manifest is not valid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null)
    throw new BadRequestException("Stored render manifest must be an object");
  const result = value as RenderManifest;
  const invalid = (field: string): never => {
    throw new BadRequestException(`Stored render manifest ${field} mismatch`);
  };
  const video: RenderArtifactView | undefined = artifacts.find(
    (artifact) => artifact.kind === "VIDEO",
  );
  const covers = artifacts.filter((artifact) => artifact.kind === "COVER");
  if (result.schemaVersion !== "1.0") invalid("schema version");
  if (result.jobId !== jobId) invalid("job");
  if (result.title !== input.title) invalid("title");
  if (result.renderSeed !== input.renderSeed) invalid("seed");
  if (
    canonicalRenderFingerprint(result.renderProfile) !== canonicalRenderFingerprint(input.profile)
  )
    invalid("profile");
  if (
    canonicalRenderFingerprint(result.sourceMediaPackage) !==
    canonicalRenderFingerprint(input.sourceMediaPackage)
  )
    invalid("source package");
  if (
    canonicalRenderFingerprint(result.pinnedInputs) !==
    canonicalRenderFingerprint({
      scenes: input.scenes,
      audio: input.audio,
      coverFrames: input.coverFrames,
    })
  )
    invalid("pinned inputs");
  if (
    canonicalRenderFingerprint(result.artifactOrder) !==
    canonicalRenderFingerprint(["VIDEO", ...input.coverFrames.map(() => "COVER"), "MANIFEST"])
  )
    invalid("artifact order");
  if (!video) invalid("video presence");
  if (result.video?.artifactId !== video!.assetId) invalid("video artifact id");
  if (result.video?.objectKey !== video!.objectKey) invalid("video key");
  if (result.video?.checksumSha256 !== video!.checksumSha256) invalid("video checksum");
  if (result.video?.byteSize !== video!.byteSize) invalid("video byte size");
  if (result.video?.durationMs !== video!.metadata?.["durationMs"]) invalid("video duration");
  if (
    canonicalRenderFingerprint(video!.metadata?.["outputProfile"]) !==
    canonicalRenderFingerprint(input.profile)
  )
    invalid("metadata profile");
  if (covers.length !== input.coverFrames.length) invalid("cover count");
  const linked = result.covers;
  if (!Array.isArray(linked) || linked.length !== covers.length)
    throw new BadRequestException("Stored render manifest has incomplete cover references");
  linked.forEach((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null)
      throw new BadRequestException("Stored cover reference is invalid");
    const value = entry as Record<string, unknown>;
    if (
      value["artifactId"] !== covers[index]?.assetId ||
      value["objectKey"] !== covers[index]?.objectKey ||
      value["checksumSha256"] !== covers[index]?.checksumSha256 ||
      value["byteSize"] !== covers[index]?.byteSize ||
      canonicalRenderFingerprint(value["selectedFrame"]) !==
        canonicalRenderFingerprint(input.coverFrames[index])
    )
      throw new BadRequestException("Stored cover reference is not bound to its artifact");
  });
  return result;
}
