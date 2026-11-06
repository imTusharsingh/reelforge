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
  CreatePromptTemplateRequestSchema,
  PromptCompileRequestSchema,
  RollbackPromptTemplateRequestSchema,
  UpdatePromptTemplateRequestSchema,
  type CreatePromptTemplateRequest,
  type PromptCompileRequest,
} from "./config.types.js";
import { translateConfigError } from "./errors.js";
import { parseRequest, requireUuid } from "./validation.js";

const editableRoles = new Set(["OWNER", "EDITOR"]);
const SNAPSHOT_WRITE_ATTEMPTS = 3;

type PromptVersionStatus = "DRAFT" | "PUBLISHED";

type PromptTemplateRow = Readonly<{
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  activeVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  activeVersion?: PromptVersionRow | null;
}>;

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

  public listTemplates(context: WorkspaceContext): Promise<PromptTemplateRow[]> {
    return this.db.promptTemplate.findMany({
      where: { workspaceId: context.workspaceId },
      include: { activeVersion: true },
      orderBy: { createdAt: "asc" },
    }) as Promise<PromptTemplateRow[]>;
  }

  public async getTemplate(
    context: WorkspaceContext,
    templateId: string,
  ): Promise<PromptTemplateRow> {
    requireUuid(templateId, "templateId");
    const template = await this.db.promptTemplate.findFirst({
      where: { workspaceId: context.workspaceId, id: templateId },
      include: {
        activeVersion: true,
        versions: { orderBy: { version: "asc" } },
      },
    });
    if (!template) throw new NotFoundException("Prompt template not found");
    return template as PromptTemplateRow;
  }

  public async createTemplate(
    context: WorkspaceContext,
    body: unknown,
  ): Promise<PromptTemplateRow> {
    this.assertCanMutate(context);
    const input = parseRequest(
      CreatePromptTemplateRequestSchema,
      body,
      "Prompt template",
    ) as CreatePromptTemplateRequest;
    try {
      return (await this.db.promptTemplate.create({
        data: {
          workspaceId: context.workspaceId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
        },
      })) as PromptTemplateRow;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          "A prompt template with that key already exists in this workspace",
        );
      throw error;
    }
  }

  public async updateTemplate(
    context: WorkspaceContext,
    templateId: string,
    body: unknown,
  ): Promise<PromptTemplateRow> {
    this.assertCanMutate(context);
    await this.getTemplate(context, templateId);
    const input = parseRequest(UpdatePromptTemplateRequestSchema, body, "Prompt template update");
    if (input.name === undefined && input.description === undefined)
      throw new BadRequestException("At least one prompt template field must be provided");
    return (await this.db.promptTemplate.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: templateId } },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    })) as PromptTemplateRow;
  }

  public async listVersions(
    context: WorkspaceContext,
    templateId: string,
  ): Promise<PromptVersionRow[]> {
    await this.getTemplate(context, templateId);
    return (await this.db.promptTemplateVersion.findMany({
      where: { workspaceId: context.workspaceId, templateId },
      orderBy: { version: "asc" },
    })) as PromptVersionRow[];
  }

  public async getVersion(
    context: WorkspaceContext,
    templateId: string,
    versionId: string,
  ): Promise<PromptVersionRow> {
    await this.getTemplate(context, templateId);
    requireUuid(versionId, "versionId");
    const version = await this.db.promptTemplateVersion.findFirst({
      where: { workspaceId: context.workspaceId, templateId, id: versionId },
    });
    if (!version) throw new NotFoundException("Prompt template version not found");
    return version as PromptVersionRow;
  }

  public async createVersion(
    context: WorkspaceContext,
    templateId: string,
    body: unknown,
  ): Promise<PromptVersionRow> {
    this.assertCanMutate(context);
    await this.getTemplate(context, templateId);
    let templateBody: PromptTemplateVersionBody;
    try {
      templateBody = parsePromptTemplateBody(body);
    } catch (error) {
      translateConfigError(error);
    }
    const checksumSha256 = jsonFingerprint(versionBodyJson(templateBody));
    const latest = await this.db.promptTemplateVersion.findFirst({
      where: { workspaceId: context.workspaceId, templateId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    try {
      return (await this.db.promptTemplateVersion.create({
        data: {
          workspaceId: context.workspaceId,
          templateId,
          version: (latest?.version ?? 0) + 1,
          status: "DRAFT",
          body: templateBody as never,
          checksumSha256,
          createdByUserId: context.userId,
        },
      })) as PromptVersionRow;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          "Another prompt template version was created concurrently; retry to create the next version",
        );
      throw error;
    }
  }

  public async updateVersion(
    context: WorkspaceContext,
    templateId: string,
    versionId: string,
    body: unknown,
  ): Promise<PromptVersionRow> {
    this.assertCanMutate(context);
    const version = await this.getVersion(context, templateId, versionId);
    if (version.status !== "DRAFT")
      throw new ConflictException("Published prompt template versions are immutable");
    let templateBody: PromptTemplateVersionBody;
    try {
      templateBody = parsePromptTemplateBody(body);
    } catch (error) {
      translateConfigError(error);
    }
    return (await this.db.promptTemplateVersion.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: version.id } },
      data: {
        body: templateBody as never,
        checksumSha256: jsonFingerprint(versionBodyJson(templateBody)),
      },
    })) as PromptVersionRow;
  }

  public async publishVersion(
    context: WorkspaceContext,
    templateId: string,
    versionId: string,
  ): Promise<PromptVersionRow> {
    this.assertCanMutate(context);
    const template = await this.getTemplate(context, templateId);
    const version = await this.getVersion(context, templateId, versionId);
    if (version.status !== "DRAFT")
      throw new ConflictException("Prompt template version is already published");
    let templateBody: PromptTemplateVersionBody;
    try {
      templateBody = parsePromptTemplateBody(version.body);
    } catch (error) {
      translateConfigError(error);
    }
    if (jsonFingerprint(versionBodyJson(templateBody)) !== version.checksumSha256)
      throw new ConflictException(
        "Prompt template version checksum does not match its body; create a new draft",
      );
    const published = await this.db.$transaction(async (tx) => {
      const updated = await tx.promptTemplateVersion.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: version.id } },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      if (template.activeVersionId === null) {
        await tx.promptTemplate.update({
          where: { workspaceId_id: { workspaceId: context.workspaceId, id: template.id } },
          data: { activeVersionId: updated.id },
        });
      }
      return updated;
    });
    return published as PromptVersionRow;
  }

  public async activateVersion(
    context: WorkspaceContext,
    templateId: string,
    versionId: string,
  ): Promise<PromptVersionRow> {
    this.assertCanMutate(context);
    const template = await this.getTemplate(context, templateId);
    const version = await this.getVersion(context, templateId, versionId);
    if (version.status !== "PUBLISHED")
      throw new ConflictException("Only published prompt template versions can be activated");
    if (template.activeVersionId === version.id)
      throw new ConflictException("Prompt template version is already active");
    await this.db.promptTemplate.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: template.id } },
      data: { activeVersionId: version.id },
    });
    return version;
  }

  public async rollback(
    context: WorkspaceContext,
    templateId: string,
    body: unknown,
  ): Promise<PromptVersionRow> {
    this.assertCanMutate(context);
    const template = await this.getTemplate(context, templateId);
    const input = parseRequest(
      RollbackPromptTemplateRequestSchema,
      body ?? {},
      "Prompt template rollback",
    );
    let target: PromptVersionRow | null = null;
    if (input.versionId !== undefined) {
      target = (await this.db.promptTemplateVersion.findFirst({
        where: {
          workspaceId: context.workspaceId,
          templateId,
          id: input.versionId,
          status: "PUBLISHED",
        },
      })) as PromptVersionRow | null;
      if (!target) throw new NotFoundException("Published prompt template version not found");
    } else {
      if (template.activeVersionId === null)
        throw new ConflictException("Prompt template has no active version to roll back");
      const active = await this.db.promptTemplateVersion.findFirst({
        where: {
          workspaceId: context.workspaceId,
          templateId,
          id: template.activeVersionId,
        },
      });
      if (!active) throw new ConflictException("Active prompt template version is missing");
      target = (await this.db.promptTemplateVersion.findFirst({
        where: {
          workspaceId: context.workspaceId,
          templateId,
          status: "PUBLISHED",
          version: { lt: active.version },
        },
        orderBy: { version: "desc" },
      })) as PromptVersionRow | null;
      if (!target)
        throw new ConflictException("No earlier published prompt template version is available");
    }
    if (template.activeVersionId === target.id)
      throw new ConflictException("Prompt template version is already active");
    await this.db.promptTemplate.update({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id: template.id } },
      data: { activeVersionId: target.id },
    });
    return target;
  }

  public async preview(context: WorkspaceContext, body: unknown): Promise<unknown> {
    const request = parseRequest(
      PromptCompileRequestSchema,
      body,
      "Prompt preview request",
    ) as PromptCompileRequest;
    const { resolved, sources } = await this.config.resolveWithSources(context, request);
    const selection = await this.resolveTemplate(
      context,
      request.template,
      resolved.config.prompt.templateRefs,
    );
    const bundle = this.compile(context, resolved, selection, request);
    return {
      config: {
        configSha256: resolved.configSha256,
        resolutionSha256: resolved.resolutionSha256,
        layers: resolved.layers,
        locks: resolved.locks,
        sources,
      },
      template: {
        templateId: selection.templateId,
        templateKey: selection.templateKey,
        templateName: selection.templateName,
        versionId: selection.versionId,
        version: selection.version,
        checksumSha256: selection.checksumSha256,
      },
      bundle,
    };
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
    const configSnapshot = await this.config.persistConfigSnapshot(context, resolved, sources);
    const bundleSnapshot = await this.persistBundle(context, configSnapshot.id, selection, bundle);
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

  public async listBundleSnapshots(
    context: WorkspaceContext,
    configSnapshotId?: string,
  ): Promise<PromptBundleSnapshotRow[]> {
    if (configSnapshotId !== undefined) requireUuid(configSnapshotId, "configSnapshotId");
    return (await this.db.promptBundleSnapshot.findMany({
      where: {
        workspaceId: context.workspaceId,
        ...(configSnapshotId === undefined ? {} : { configSnapshotId }),
      },
      orderBy: { version: "desc" },
      take: 100,
    })) as PromptBundleSnapshotRow[];
  }

  public async getBundleSnapshot(
    context: WorkspaceContext,
    snapshotId: string,
  ): Promise<PromptBundleSnapshotRow> {
    requireUuid(snapshotId, "snapshotId");
    const snapshot = await this.db.promptBundleSnapshot.findFirst({
      where: { workspaceId: context.workspaceId, id: snapshotId },
    });
    if (!snapshot) throw new NotFoundException("Prompt bundle snapshot not found");
    return snapshot as PromptBundleSnapshotRow;
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

  private async persistBundle(
    context: WorkspaceContext,
    configSnapshotId: string,
    selection: PromptTemplateSelection,
    bundle: CompiledPromptBundle,
  ): Promise<PromptBundleSnapshotRow> {
    const bundleJson = bundle as unknown as JsonValue;
    let lastError: unknown;
    for (let attempt = 0; attempt < SNAPSHOT_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return (await this.db.$transaction(async (tx) => {
          const latest = await tx.promptBundleSnapshot.findFirst({
            where: { workspaceId: context.workspaceId },
            orderBy: { version: "desc" },
            select: { version: true },
          });
          return tx.promptBundleSnapshot.create({
            data: {
              workspaceId: context.workspaceId,
              version: (latest?.version ?? 0) + 1,
              configSnapshotId,
              templateId: selection.templateId,
              templateVersionId: selection.versionId,
              bundle: bundleJson as never,
              fingerprintSha256: bundle.fingerprintSha256,
              createdByUserId: context.userId,
            },
          });
        })) as PromptBundleSnapshotRow;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        lastError = error;
      }
    }
    throw new ConflictException(
      lastError instanceof Error
        ? `Could not allocate the next prompt bundle snapshot version: ${lastError.message}`
        : "Could not allocate the next prompt bundle snapshot version",
    );
  }
}
