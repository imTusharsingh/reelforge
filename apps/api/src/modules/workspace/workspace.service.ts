import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";

@Injectable()
export class WorkspaceService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}

  public async context(userId: string, workspaceId: string): Promise<WorkspaceContext> {
    const membership = await this.db.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, include: { workspace: true } });
    if (!membership || membership.workspace.archivedAt) throw new ForbiddenException("Workspace access denied");
    return { workspaceId, userId, role: membership.role };
  }

  public async create(userId: string, name: string): Promise<{ id: string; name: string }> {
    const workspace = await this.db.workspace.create({ data: { name: name.trim(), memberships: { create: { userId, role: "OWNER" } } }, select: { id: true, name: true } });
    await this.db.user.update({ where: { id: userId }, data: { defaultWorkspaceId: workspace.id } });
    return workspace;
  }

  public async list(userId: string): Promise<Array<{ id: string; name: string; archivedAt: Date | null }>> {
    return this.db.workspace.findMany({ where: { archivedAt: null, memberships: { some: { userId } } }, select: { id: true, name: true, archivedAt: true }, orderBy: { createdAt: "asc" } });
  }

  public async archive(context: WorkspaceContext): Promise<void> {
    if (context.role !== "OWNER") throw new ForbiddenException("Owner permission required");
    const result = await this.db.workspace.updateMany({ where: { id: context.workspaceId, memberships: { some: { userId: context.userId, role: "OWNER" } }, archivedAt: null }, data: { archivedAt: new Date() } });
    if (result.count !== 1) throw new NotFoundException("Workspace not found");
  }
}
