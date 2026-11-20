import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { TokenVault } from "../social-accounts/token-vault.js";
import { providerKey, providerKeyIssue } from "@reelforge/ai-providers";

const vendorSchema = z.enum(["gemini", "xai"]);
const keySchema = z.object({ key: z.string().max(4096) }).strict();
export type Vendor = z.infer<typeof vendorSchema>;
export function parseVendor(value: string): Vendor {
  const parsed = vendorSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("Unsupported provider");
  return parsed.data;
}
/** ADR-003 boundary: verified membership, workspace predicate on every query, no raw row responses. */
@Injectable()
export class ProviderKeys {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly vault: TokenVault,
  ) {}
  public async write(
    context: WorkspaceContext,
    providerId: Vendor,
    body: unknown,
  ): Promise<{ configured: true }> {
    this.guard(context, true);
    const parsed = keySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("A provider key is required");
    const issue = providerKeyIssue(providerId, parsed.data.key);
    if (issue)
      throw new BadRequestException({ code: issue, message: "Enter a valid provider key" });
    const encrypted = this.vault.encrypt(parsed.data.key, `${context.workspaceId}:${providerId}`);
    await this.db.providerKey.upsert({
      where: { workspaceId_providerId: { workspaceId: context.workspaceId, providerId } },
      create: { workspaceId: context.workspaceId, providerId, ...encrypted },
      update: encrypted,
    });
    return { configured: true };
  }
  public async remove(context: WorkspaceContext, providerId: Vendor): Promise<void> {
    this.guard(context, true);
    await this.db.providerKey.deleteMany({
      where: { workspaceId: context.workspaceId, providerId },
    });
  }
  public async configured(context: WorkspaceContext): Promise<{ gemini: boolean; xai: boolean }> {
    this.guard(context, false);
    const rows = await this.db.providerKey.findMany({
      where: { workspaceId: context.workspaceId },
      select: { providerId: true },
    });
    return {
      gemini:
        !!providerKey("gemini", process.env) || rows.some((row) => row.providerId === "gemini"),
      xai: !!providerKey("xai", process.env) || rows.some((row) => row.providerId === "xai"),
    };
  }
  /** Server-only resolver; never expose through a controller or return in health responses. */
  public async resolve(context: WorkspaceContext, providerId: Vendor): Promise<string | undefined> {
    this.guard(context, true);
    const row = await this.db.providerKey.findUnique({
      where: { workspaceId_providerId: { workspaceId: context.workspaceId, providerId } },
    });
    if (!row) return providerKey(providerId, process.env);
    if (row.keyVersion !== "env-v1") throw new Error("Unsupported provider key version");
    return this.vault.decrypt(
      { ...row, keyVersion: "env-v1" },
      `${context.workspaceId}:${providerId}`,
    );
  }
  private guard(context: WorkspaceContext, write: boolean): void {
    if (!context.workspaceId || !context.userId || (write && context.role !== "OWNER"))
      throw new ForbiddenException("Workspace owner required");
  }
}
