import { z } from "zod";
import {
  LayerValuesSchema,
  LockPathSchema,
  PromptAdditionInputSchema,
  PromptTemplateReferenceSchema,
  VideoOverrideSchema,
  type ResolvedConfig,
} from "@reelforge/config-engine";

const variableValuesSchema = z.record(z.string().trim().min(1).max(64), z.string().max(20000));

function refineWorkspaceOptions(
  value: {
    workspaceConfigSnapshotId?: string | undefined;
    workspaceValues?: unknown;
    workspaceLockedFields?: string[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.workspaceValues !== undefined && value.workspaceConfigSnapshotId !== undefined) {
    context.addIssue({
      code: "custom",
      message: "workspaceValues and workspaceConfigSnapshotId cannot be combined",
      path: ["workspaceValues"],
    });
  }
  if (value.workspaceLockedFields !== undefined && value.workspaceValues === undefined) {
    context.addIssue({
      code: "custom",
      message: "workspaceLockedFields requires workspaceValues",
      path: ["workspaceLockedFields"],
    });
  }
}

const resolveShape = {
  workspaceConfigSnapshotId: z.uuid().optional(),
  workspaceValues: LayerValuesSchema.optional(),
  workspaceLockedFields: z.array(LockPathSchema).max(200).optional(),
  channelId: z.uuid().optional(),
  genreId: z.uuid().optional(),
  seriesId: z.uuid().optional(),
  characterVersionIds: z.array(z.uuid()).max(20).optional(),
  video: VideoOverrideSchema.optional(),
  promptTemplateRefs: z.array(PromptTemplateReferenceSchema).max(20).optional(),
};

export const PromptCompileRequestSchema = z
  .object({
    ...resolveShape,
    template: PromptTemplateReferenceSchema.optional(),
    variables: variableValuesSchema.optional(),
    additions: z.array(PromptAdditionInputSchema).max(50).optional(),
  })
  .strict()
  .superRefine(refineWorkspaceOptions);

export type ResolveConfigRequest = z.infer<z.ZodObject<typeof resolveShape>>;
export type PromptCompileRequest = z.infer<typeof PromptCompileRequestSchema>;
export type ResolvedConfigSources = Readonly<{
  workspaceConfigSnapshotId: string | null;
  channelId: string | null;
  genreId: string | null;
  seriesId: string | null;
}>;

export type ResolvedConfigWithSources = Readonly<{
  resolved: ResolvedConfig;
  sources: ResolvedConfigSources;
}>;

export type WorkspaceSnapshotRow = Readonly<{
  id: string;
  workspaceId: string;
  version: number;
  values: unknown;
  lockedFields: unknown;
  fingerprintSha256: string;
  createdByUserId: string | null;
  createdAt: Date;
}>;

export type ConfigSnapshotRow = Readonly<{
  id: string;
  workspaceId: string;
  version: number;
  workspaceConfigSnapshotId: string | null;
  channelId: string | null;
  genreId: string | null;
  seriesId: string | null;
  config: unknown;
  fingerprintSha256: string;
  resolutionSha256: string;
  layers: unknown;
  lockedFields: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}>;
