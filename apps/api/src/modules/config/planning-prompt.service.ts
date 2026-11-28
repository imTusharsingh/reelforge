import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { foundationWorkspaceGuard } from "@reelforge/database";
import { jsonFingerprint } from "@reelforge/config-engine";
import type { PlanningPromptReceipt } from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { PromptService } from "./prompt.service.js";
import { planningPrompts } from "./planning-prompts.js";

const captureSchema = z.object({
  configSnapshot: z.object({ id: z.uuid() }),
  promptBundleSnapshot: z.object({
    id: z.uuid(),
    templateVersionId: z.uuid(),
    fingerprintSha256: z.string(),
  }),
  bundle: z.object({ renderedText: z.string() }),
});
@Injectable()
export class PlanningPromptService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly prompts: PromptService,
  ) {}
  public async format(context: WorkspaceContext, key: string): Promise<unknown> {
    const format = await foundationWorkspaceGuard(this.db, context).formatTemplate.findFirst({
      where: { key, version: 1 },
    });
    if (!format) throw new Error("Seeded format template missing");
    return { key: format.key, version: format.version, structure: format.structure };
  }
  public async capture(
    context: WorkspaceContext,
    channelId: string,
    role: PlanningPromptReceipt["role"],
  ): Promise<{ prompt: string; receipt: PlanningPromptReceipt }> {
    const template = await this.db.promptTemplate.findFirst({
      where: { workspaceId: context.workspaceId, key: `v1.${role}` },
    });
    if (!template) throw new Error("V1 prompt seed missing");
    const body = {
      ...planningPrompts[role],
      variables: [],
      allowedAdditionSections: ["instructions"],
    };
    const checksumSha256 = jsonFingerprint(body);
    const promptVersion = role === "scriptwriter" ? 3 : 2;
    const version = await this.db.promptTemplateVersion.upsert({
      where: {
        workspaceId_templateId_version: {
          workspaceId: context.workspaceId,
          templateId: template.id,
          version: promptVersion,
        },
      },
      create: {
        workspaceId: context.workspaceId,
        templateId: template.id,
        version: promptVersion,
        status: "PUBLISHED",
        body,
        checksumSha256,
        publishedAt: new Date(),
      },
      update: {},
    });
    if (version.checksumSha256 !== checksumSha256 || version.status !== "PUBLISHED")
      throw new Error(
        `Planning prompt v${promptVersion} conflicts with an existing immutable version`,
      );
    const captured = captureSchema.parse(
      await this.prompts.capture(context, {
        channelId,
        template: { templateKey: template.key, version: promptVersion },
      }),
    );
    return {
      prompt: captured.bundle.renderedText,
      receipt: {
        role,
        version: promptVersion,
        templateVersionId: captured.promptBundleSnapshot.templateVersionId,
        promptSnapshotId: captured.promptBundleSnapshot.id,
        configSnapshotId: captured.configSnapshot.id,
        fingerprintSha256: captured.promptBundleSnapshot.fingerprintSha256,
      },
    };
  }
}
