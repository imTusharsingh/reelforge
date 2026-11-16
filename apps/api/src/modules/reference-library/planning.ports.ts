import type { z } from "zod";
import type {
  ChannelReferenceDefaults,
  ReferenceAsset,
  PlanningPromptReceipt,
  ReferencePin,
} from "@reelforge/contracts";
import type { WorkspaceContext } from "../identity/identity.types.js";

export const PLANNING_TEXT = "PLANNING_TEXT";
export const PLANNING_IMAGES = "PLANNING_IMAGES";
export const REFERENCE_LIBRARY = "REFERENCE_LIBRARY";
/** V2 bridge: caller supplies structured JSON schema; provider accounting belongs to V2/V3. */
export interface TextPort {
  generate(input: {
    workspaceId: string;
    runId: string;
    idempotencyKey: string;
    prompt: string;
    modelId: string;
    schema: z.ZodType;
    promptVersion: PlanningPromptReceipt;
  }): Promise<unknown>;
}
/** Returns downloaded bytes, never a provider URL; V2 owns dispatch and accounting. */
export interface ImageGenPort {
  generate(input: {
    workspaceId: string;
    runId: string;
    idempotencyKey: string;
    prompt: string;
    modelId: string;
    references: readonly ReferenceAsset[];
  }): Promise<{ body: Buffer; mediaType: "image/png" | "image/jpeg" | "image/webp" }>;
}
export interface ReferenceLibrary {
  resolve(context: WorkspaceContext, pins: readonly ReferencePin[]): Promise<ReferenceAsset[]>;
  defaults(context: WorkspaceContext, channelId: string): Promise<ChannelReferenceDefaults | null>;
  save(context: WorkspaceContext, asset: ReferenceAsset): Promise<void>;
  setDefaults(context: WorkspaceContext, defaults: ChannelReferenceDefaults): Promise<void>;
}
/** Fail-closed until V2 bindings are supplied. No fake successful production responses. */
export class UnconfiguredTextPort implements TextPort {
  public generate(): never {
    throw new Error("V2 planning TextPort is not configured");
  }
}
export class UnconfiguredImageGenPort implements ImageGenPort {
  public generate(): never {
    throw new Error("V2 planning ImageGenPort is not configured");
  }
}
