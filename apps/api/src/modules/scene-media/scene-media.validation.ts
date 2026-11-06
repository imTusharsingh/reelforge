import { BadRequestException } from "@nestjs/common";
import {
  ProviderError,
  type CapabilityMetadata,
  type ProviderEnvironment,
} from "@reelforge/ai-providers";
import { z } from "zod";
import type { AssetMediaType } from "../asset/asset.types.js";
import {
  assetExtension,
  validateUploadPayload,
  type ValidatedUpload,
} from "../asset/asset.validation.js";
import type { ScriptScene } from "../script/script.types.js";
import {
  SCENE_MEDIA_SCHEMA_VERSION,
  type RequestedOutputs,
  type SceneMediaKind,
  type SceneMediaPackage,
} from "./scene-media.types.js";

const outputsSchema = z.object({
  image: z.literal(true),
  video: z.boolean().optional().default(false),
  narration: z.boolean().optional().default(false),
  dialogue: z.boolean().optional().default(false),
});

const createSchema = z.object({
  scriptId: z.uuid(),
  idempotencyKey: z.string().trim().min(1).max(200),
  outputs: outputsSchema,
});

const replaceSchema = z.object({
  kind: z.enum(["IMAGE", "VIDEO", "NARRATION", "DIALOGUE"]),
});

const promptBundleSchema = z.object({
  renderedText: z.string().min(1),
  fingerprintSha256: z.string().length(64),
});

export const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  seconds: z.number().nonnegative().optional(),
  characters: z.number().int().nonnegative().optional(),
});

export const provenanceSchema = z.object({
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  cost: z.number().finite().nonnegative().nullable(),
  currency: z.string().min(1).optional(),
  usage: providerUsageSchema.optional(),
});
export type ParsedProvenance = z.infer<typeof provenanceSchema>;
export type NormalizedUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  seconds?: number;
  characters?: number;
}>;
export type NormalizedMediaResult = Readonly<{
  envelopeValid: boolean;
  mediaId: string | null;
  providerRequestId: string | null;
  providerJobId: string | null;
  declaredMediaType: string | null;
  body: Uint8Array | null;
  provenanceValid: boolean;
  modelVersion: string | null;
  promptVersion: string | null;
  cost: number | null;
  currency: string | null;
  usage: NormalizedUsage | null;
}>;

const invalidMediaResult: NormalizedMediaResult = {
  envelopeValid: false,
  mediaId: null,
  providerRequestId: null,
  providerJobId: null,
  declaredMediaType: null,
  body: null,
  provenanceValid: false,
  modelVersion: null,
  promptVersion: null,
  cost: null,
  currency: null,
  usage: null,
};

/** Never throws. Missing, null, and non-object metadata become an invalid provenance with no usage. */
export function normalizeMediaResult(raw: unknown): NormalizedMediaResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalidMediaResult;
  const record = raw as Record<string, unknown>;
  const media =
    typeof record.media === "object" && record.media !== null && !Array.isArray(record.media)
      ? (record.media as Record<string, unknown>)
      : null;
  const mediaId = nonEmptyString(record.mediaId);
  const declaredMediaType = media === null ? null : nonEmptyString(media.declaredMediaType);
  const body = media?.body instanceof Uint8Array ? media.body : null;
  return {
    envelopeValid: mediaId !== null && declaredMediaType !== null && body !== null,
    mediaId,
    providerRequestId: nonEmptyString(record.providerRequestId),
    providerJobId: nonEmptyString(record.providerJobId),
    declaredMediaType,
    body,
    ...normalizeProvenance(
      record.metadata,
      Object.prototype.hasOwnProperty.call(record, "metadata"),
    ),
  };
}

function normalizeProvenance(
  metadata: unknown,
  present: boolean,
): Pick<
  NormalizedMediaResult,
  "provenanceValid" | "modelVersion" | "promptVersion" | "cost" | "currency" | "usage"
> {
  const invalid = {
    provenanceValid: false,
    modelVersion: null,
    promptVersion: null,
    cost: null,
    currency: null,
    usage: null,
  };
  if (!present || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return invalid;
  }
  const parsed = provenanceSchema.safeParse(metadata);
  if (!parsed.success) return invalid;
  const hasUsage = Object.prototype.hasOwnProperty.call(metadata, "usage");
  return {
    provenanceValid: true,
    modelVersion: parsed.data.modelVersion,
    promptVersion: parsed.data.promptVersion,
    cost: parsed.data.cost,
    currency: parsed.data.currency ?? null,
    usage: hasUsage ? compactUsage(parsed.data.usage) : null,
  };
}

function compactUsage(usage: ParsedProvenance["usage"]): NormalizedUsage | null {
  if (usage === undefined) return null;
  const compact: {
    inputTokens?: number;
    outputTokens?: number;
    seconds?: number;
    characters?: number;
  } = {};
  if (usage.inputTokens !== undefined) compact.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) compact.outputTokens = usage.outputTokens;
  if (usage.seconds !== undefined) compact.seconds = usage.seconds;
  if (usage.characters !== undefined) compact.characters = usage.characters;
  return Object.keys(compact).length === 0 ? null : compact;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const mediaResponseSchema = z.object({
  mediaId: z.string().min(1),
  providerRequestId: z.string().min(1).optional(),
  providerJobId: z.string().min(1).optional(),
  metadata: z.unknown(),
  media: z.object({
    declaredMediaType: z.string().min(1),
    body: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  }),
});

const KIND_MEDIA: Readonly<Record<SceneMediaKind, readonly AssetMediaType[]>> = {
  IMAGE: ["image/png", "image/jpeg", "image/webp"],
  VIDEO: ["video/mp4"],
  NARRATION: ["audio/mpeg", "audio/wav"],
  DIALOGUE: ["audio/mpeg", "audio/wav"],
};

export type CreateSceneMediaInput = Readonly<{
  scriptId: string;
  idempotencyKey: string;
  outputs: RequestedOutputs;
}>;

export function parseCreateInput(body: unknown): CreateSceneMediaInput {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function parseReplaceInput(body: unknown): SceneMediaKind {
  const parsed = replaceSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data.kind;
}

export function parsePromptBundle(value: unknown): {
  renderedText: string;
  fingerprintSha256: string;
} {
  const parsed = promptBundleSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export function providerEnvironment(env: NodeJS.ProcessEnv = process.env): ProviderEnvironment {
  return env.NODE_ENV === "production" ? "production" : "development";
}

export function applicableKinds(scene: ScriptScene, outputs: RequestedOutputs): SceneMediaKind[] {
  const kinds: SceneMediaKind[] = ["IMAGE"];
  if (outputs.video) kinds.push("VIDEO");
  if (outputs.narration && (scene.narration?.trim().length ?? 0) > 0) kinds.push("NARRATION");
  if (outputs.dialogue && scene.dialogue.trim().length > 0) kinds.push("DIALOGUE");
  return kinds;
}

export function readVoice(preference: unknown, lane: "narration" | "dialogue"): string | undefined {
  if (typeof preference !== "object" || preference === null || Array.isArray(preference))
    return undefined;
  const record = preference as Record<string, unknown>;
  const specific = lane === "narration" ? record.narrationVoice : record.dialogueVoice;
  const fallback = record.voice ?? record.voiceId;
  const value = typeof specific === "string" && specific.trim().length > 0 ? specific : fallback;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function buildScenePrompt(
  input: Readonly<{
    renderedText: string;
    config: unknown;
    scene: ScriptScene;
    characters: readonly Readonly<{
      characterId: string;
      characterVersionId: string;
      checksumSha256: string;
      referenceAssetIds: readonly string[];
    }>[];
  }>,
): string {
  return [
    input.renderedText,
    `Configuration: ${JSON.stringify(input.config)}`,
    `Scene: ${input.scene.id}`,
    `Visual: ${input.scene.visualDescription}`,
    `Camera: ${input.scene.camera}`,
    `Dialogue: ${input.scene.dialogue}`,
    `Narration: ${input.scene.narration ?? ""}`,
    `Character references: ${JSON.stringify(input.characters)}`,
  ].join("\n");
}

export function assertImageCapability(
  capability: CapabilityMetadata,
  hasReferenceImages: boolean,
  correlationId: string,
): void {
  if (capability.kind !== "image") {
    throw new ProviderError(
      "INVALID_REQUEST",
      "Image generation requires a provider capability of kind image",
      correlationId,
    );
  }
  if (hasReferenceImages && !capability.supportsReferenceImages) {
    throw new ProviderError(
      "INVALID_REQUEST",
      "Image capability does not accept the scene character reference images",
      correlationId,
    );
  }
}

export function assertVideoCapability(
  capability: CapabilityMetadata,
  durationSeconds: number,
  correlationId: string,
): void {
  if (capability.kind !== "video") {
    throw new ProviderError(
      "INVALID_REQUEST",
      "Motion generation requires a provider capability of kind video",
      correlationId,
    );
  }
  const range = capability.durationSeconds;
  if (range !== undefined && (durationSeconds < range.min || durationSeconds > range.max)) {
    throw new ProviderError(
      "INVALID_REQUEST",
      "Scene duration is outside the video capability range",
      correlationId,
    );
  }
}

export function assertTtsCapability(capability: CapabilityMetadata, correlationId: string): void {
  if (capability.kind !== "tts") {
    throw new ProviderError(
      "INVALID_REQUEST",
      "Speech generation requires a provider capability of kind tts",
      correlationId,
    );
  }
}

export function validateGeneratedMedia(
  kind: SceneMediaKind,
  declaredMediaType: string,
  body: Uint8Array,
): ValidatedUpload & { body: Buffer } {
  const buffer = Buffer.from(body);
  const filename = `generated-${kind.toLowerCase()}.${extensionFor(declaredMediaType)}`;
  const validated = validateUploadPayload({
    body: buffer,
    declaredMediaType,
    filename,
  });
  if (!KIND_MEDIA[kind].includes(validated.mediaType)) {
    throw new BadRequestException(
      `Generated ${kind} media type ${validated.mediaType} is not acceptable`,
    );
  }
  if (validated.byteSize <= 0) throw new BadRequestException("Generated media is empty");
  return { ...validated, body: buffer };
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
        scene.outputs.every(
          (output) =>
            (output.status === "SUCCEEDED" || output.status === "REUSED") &&
            output.assetId !== null &&
            output.assetVersion !== null &&
            output.assetVersion >= 1 &&
            output.byteSize !== null &&
            output.byteSize > 0 &&
            output.checksumSha256 !== null &&
            output.checksumSha256.length === 64 &&
            output.providerAssetId !== null &&
            output.providerAssetId.length > 0 &&
            output.mediaType !== null,
        ),
    )
  );
}

function extensionFor(declaredMediaType: string): string {
  const normalized = declaredMediaType.split(";")[0]?.trim().toLowerCase();
  if (
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/webp" ||
    normalized === "audio/mpeg" ||
    normalized === "audio/wav" ||
    normalized === "video/mp4"
  ) {
    return assetExtension(normalized);
  }
  return "bin";
}
