import { BadRequestException } from "@nestjs/common";
import {
  AssignSceneAssetRequestSchema,
  SceneMediaJobListQuerySchema,
  type AssignSceneAssetRequest,
  type SceneMediaJobListQuery,
} from "@reelforge/contracts";
import type { ProviderEnvironment } from "@reelforge/ai-providers";
import type { AssetMediaType } from "../asset/asset.types.js";
import {
  SCENE_MEDIA_SCHEMA_VERSION,
  type SceneMediaKind,
  type SceneMediaPackage,
} from "./scene-media.types.js";
/** Historic package readers/C3 assignment only. No provider invocation or still-image producer. */
export const KIND_MEDIA: Readonly<Record<SceneMediaKind, readonly AssetMediaType[]>> = {
  IMAGE: ["image/png", "image/jpeg", "image/webp"],
  VIDEO: ["video/mp4"],
  NARRATION: ["audio/mpeg", "audio/wav"],
  DIALOGUE: ["audio/mpeg", "audio/wav"],
};
export function parseAssignAssetInput(body: unknown): AssignSceneAssetRequest {
  const parsed = AssignSceneAssetRequestSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}
export function parseSceneMediaJobListQuery(query: unknown): SceneMediaJobListQuery {
  const parsed = SceneMediaJobListQuerySchema.safeParse(query);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}
export function providerEnvironment(env: NodeJS.ProcessEnv = process.env): ProviderEnvironment {
  return env.NODE_ENV === "production"
    ? "production"
    : env.NODE_ENV === "staging"
      ? "staging"
      : env.NODE_ENV === "test"
        ? "test"
        : "development";
}
export function isCompletePackage(pkg: SceneMediaPackage): boolean {
  return (
    pkg.schemaVersion === SCENE_MEDIA_SCHEMA_VERSION &&
    pkg.status === "SUCCEEDED" &&
    pkg.scenes.length > 0 &&
    pkg.scenes.every(
      (scene) =>
        scene.status === "SUCCEEDED" &&
        scene.outputs.length > 0 &&
        scene.outputs.every((output) => {
          if (
            output.status !== "SUCCEEDED" &&
            output.status !== "REUSED" &&
            output.status !== "ASSIGNED"
          )
            return false;
          if (
            output.assetId === null ||
            output.assetVersion === null ||
            output.assetVersion < 1 ||
            output.byteSize === null ||
            output.byteSize <= 0 ||
            output.checksumSha256 === null ||
            output.checksumSha256.length !== 64 ||
            output.mediaType === null
          )
            return false;
          if (output.status === "ASSIGNED") return true;
          return output.providerAssetId !== null && output.providerAssetId.length > 0;
        }),
    )
  );
}
