import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  compilePrompt,
  jsonFingerprint,
  parsePromptTemplateBody,
  promptTemplateReferenceTarget,
  type CompiledPromptBundle,
  type JsonValue,
  type PromptTemplateReference,
  type PromptTemplateSelection,
  type PromptTemplateVersionBody,
} from "@reelforge/config-engine";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ConfigService } from "./config.service.js";
import {
  PromptCompileRequestSchema,
  type PromptCompileRequest,
  type ConfigSnapshotRow,
  type ResolvedConfigSources,
} from "./config.types.js";
import { translateConfigError } from "./errors.js";
import { parseRequest } from "./validation.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);

type PromptVersionStatus = "DRAFT" | "PUBLISHED";

type PromptVersionRow = Readonly<{
  id: string;
  workspaceId: string;
  templateId: string;
  version: number;
  status: PromptVersionStatus;
  body: unknown;
  checksumSha256: string;
  createdByUserId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}>;

type PromptBundleSnapshotRow = Readonly<{
  id: string;
  workspaceId: string;
  version: number;
  configSnapshotId: string;
  templateId: string;
  templateVersionId: string;
  bundle: unknown;
  fingerprintSha256: string;
  createdByUserId: string | null;
  createdAt: Date;
}>;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function versionBodyJson(body: PromptTemplateVersionBody): JsonValue {
  return body as unknown as JsonValue;
}

@Injectable()
export class PromptService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  private assertCanMutate(context: WorkspaceContext): void {
    if (!editableRoles.has(context.role))
      throw new ForbiddenException("Prompt mutation requires owner or editor access");
  }

  public async capture(context: WorkspaceContext, body: unknown): Promise<unknown> {
    this.assertCanMutate(context);
    const request = parseRequest(
      PromptCompileRequestSchema,
      body,
      "Generation snapshot request",
    ) as PromptCompileRequest;
    const { resolved, sources } = await this.config.resolveWithSources(context, request);
    const selection = await this.resolveTemplate(
      context,
      request.template,
      resolved.config.prompt.templateRefs,
    );
    const bundle = this.compile(context, resolved, selection, request);
    const { configSnapshot, bundleSnapshot } = await this.persistCapture(
      context,
      resolved,
      sources,
      selection,
      bundle,
    );
    return {
      configSnapshot: {
        id: configSnapshot.id,
        version: configSnapshot.version,
        fingerprintSha256: configSnapshot.fingerprintSha256,
        resolutionSha256: configSnapshot.resolutionSha256,
        workspaceConfigSnapshotId: configSnapshot.workspaceConfigSnapshotId,
        channelId: configSnapshot.channelId,
        genreId: configSnapshot.genreId,
        seriesId: configSnapshot.seriesId,
        createdAt: configSnapshot.createdAt,
      },
      promptBundleSnapshot: {
        id: bundleSnapshot.id,
        version: bundleSnapshot.version,
        configSnapshotId: bundleSnapshot.configSnapshotId,
        templateId: bundleSnapshot.templateId,
        templateVersionId: bundleSnapshot.templateVersionId,
        fingerprintSha256: bundleSnapshot.fingerprintSha256,
        createdAt: bundleSnapshot.createdAt,
      },
      bundle,
    };
  }

  private compile(
    context: WorkspaceContext,
    resolved: import("@reelforge/config-engine").ResolvedConfig,
    selection: PromptTemplateSelection,
    request: PromptCompileRequest,
  ): CompiledPromptBundle {
    try {
      return compilePrompt({
        config: resolved.config,
        configSha256: resolved.configSha256,
        template: selection,
        ...(request.variables === undefined ? {} : { variables: request.variables }),
        ...(request.additions === undefined
          ? {}
          : {
              additions: request.additions.map((addition) => ({
                ...addition,
                addedByUserId: context.userId,
              })),
            }),
      });
    } catch (error) {
      translateConfigError(error);
    }
  }

  private async resolveTemplate(
    context: WorkspaceContext,
    reference: PromptTemplateReference | undefined,
    fallback: readonly PromptTemplateReference[],
  ): Promise<PromptTemplateSelection> {
    const selected = reference ?? fallback[0];
    if (selected === undefined)
      throw new BadRequestException(
        "No prompt template was selected and the resolved configuration has no prompt template reference",
      );
    const target = promptTemplateReferenceTarget(selected);
    const template =
      target.templateId !== undefined
        ? await this.db.promptTemplate.findFirst({
            where: { workspaceId: context.workspaceId, id: target.templateId },
          })
        : target.templateKey !== undefined
          ? await this.db.promptTemplate.findFirst({
              where: { workspaceId: context.workspaceId, key: target.templateKey },
            })
          : null;
    if (!template) throw new NotFoundException("Prompt template not found");

    let version: PromptVersionRow | null;
    if (target.version !== undefined) {
      version = (await this.db.promptTemplateVersion.findFirst({
        where: {
          workspaceId: context.workspaceId,
          templateId: template.id,
          version: target.version,
          status: "PUBLISHED",
        },
      })) as PromptVersionRow | null;
      if (!version) throw new NotFoundException("Published prompt template version not found");
    } else {
      if (template.activeVersionId === null)
        throw new ConflictException("Prompt template has no active published version");
      version = (await this.db.promptTemplateVersion.findFirst({
        where: {
          workspaceId: context.workspaceId,
          templateId: template.id,
          id: template.activeVersionId,
          status: "PUBLISHED",
        },
      })) as PromptVersionRow | null;
      if (!version) throw new ConflictException("Active prompt template version is not published");
    }

    let body: PromptTemplateVersionBody;
    try {
      body = parsePromptTemplateBody(version.body);
    } catch (error) {
      translateConfigError(error);
    }
    const computedChecksum = jsonFingerprint(versionBodyJson(body));
    if (computedChecksum !== version.checksumSha256)
      throw new ConflictException(
        "Prompt template version checksum does not match its body; create a new draft",
      );
    return {
      templateId: template.id,
      templateKey: template.key,
      templateName: template.name,
      versionId: version.id,
      version: version.version,
      checksumSha256: version.checksumSha256,
      body,
    };
  }

  private async persistCapture(
    context: WorkspaceContext,
    resolved: import("@reelforge/config-engine").ResolvedConfig,
    sources: ResolvedConfigSources,
    selection: PromptTemplateSelection,
    bundle: CompiledPromptBundle,
  ): Promise<{
    configSnapshot: ConfigSnapshotRow;
    bundleSnapshot: PromptBundleSnapshotRow;
  }> {
    try {
      return (await this.db.$transaction(async (tx) => {
        const latestConfig = await tx.configSnapshot.findFirst({
          where: { workspaceId: context.workspaceId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const configSnapshot = await tx.configSnapshot.create({
          data: {
            workspaceId: context.workspaceId,
            version: (latestConfig?.version ?? 0) + 1,
            workspaceConfigSnapshotId: sources.workspaceConfigSnapshotId,
            channelId: sources.channelId,
            genreId: sources.genreId,
            seriesId: sources.seriesId,
            config: resolved.config as never,
            fingerprintSha256: resolved.configSha256,
            resolutionSha256: resolved.resolutionSha256,
            layers: resolved.layers as never,
            lockedFields: resolved.lockedFields as never,
            createdByUserId: context.userId,
          },
        });
        const latestBundle = await tx.promptBundleSnapshot.findFirst({
          where: { workspaceId: context.workspaceId },
          orderBy: { version: "desc" },
          select: { version: true },
        });
        const bundleSnapshot = await tx.promptBundleSnapshot.create({
          data: {
            workspaceId: context.workspaceId,
            version: (latestBundle?.version ?? 0) + 1,
            configSnapshotId: configSnapshot.id,
            templateId: selection.templateId,
            templateVersionId: selection.versionId,
            bundle: bundle as never,
            fingerprintSha256: bundle.fingerprintSha256,
            createdByUserId: context.userId,
          },
        });
        return { configSnapshot, bundleSnapshot };
      })) as {
        configSnapshot: ConfigSnapshotRow;
        bundleSnapshot: PromptBundleSnapshotRow;
      };
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("Concurrent snapshot capture detected; retry the capture");
      throw error;
    }
  }
}
