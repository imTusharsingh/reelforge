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

export const ResolveConfigRequestSchema = z
  .object(resolveShape)
  .strict()
  .superRefine(refineWorkspaceOptions);

export const WorkspaceConfigSaveRequestSchema = z
  .object({
    values: LayerValuesSchema,
    lockedFields: z.array(LockPathSchema).max(200).default([]),
  })
  .strict();

export const PromptCompileRequestSchema = z
  .object({
    ...resolveShape,
    template: PromptTemplateReferenceSchema.optional(),
    variables: variableValuesSchema.optional(),
    additions: z.array(PromptAdditionInputSchema).max(50).optional(),
  })
  .strict()
  .superRefine(refineWorkspaceOptions);

export const CreatePromptTemplateRequestSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{0,63}$/, "must be a lowercase key using letters, digits, and dashes"),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const UpdatePromptTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const RollbackPromptTemplateRequestSchema = z
  .object({
    versionId: z.uuid().optional(),
  })
  .strict();

export type ResolveConfigRequest = z.infer<typeof ResolveConfigRequestSchema>;
export type WorkspaceConfigSaveRequest = z.infer<typeof WorkspaceConfigSaveRequestSchema>;
export type PromptCompileRequest = z.infer<typeof PromptCompileRequestSchema>;
export type CreatePromptTemplateRequest = z.infer<typeof CreatePromptTemplateRequestSchema>;
export type UpdatePromptTemplateRequest = z.infer<typeof UpdatePromptTemplateRequestSchema>;
export type RollbackPromptTemplateRequest = z.infer<typeof RollbackPromptTemplateRequestSchema>;

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
