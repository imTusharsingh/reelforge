import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { WorkspaceRepository } from "./workspace.repository.js";

@Injectable()
export class WorkspaceService {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly repository: WorkspaceRepository,
  ) {}

  public async context(userId: string, workspaceId: string): Promise<WorkspaceContext> {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { workspace: true },
    });
    if (!membership || membership.workspace.archivedAt)
      throw new ForbiddenException("Workspace access denied");
    const context = { workspaceId, userId, role: membership.role };
    const workspace = await this.repository.findById(context, workspaceId);
    if (!workspace || workspace.archivedAt) throw new ForbiddenException("Workspace access denied");
    return context;
  }

  /**
   * @internal Member read for M17 notification fan-out and recipient resolution. Read-only;
   * never expose it through a controller.
   */
  public async listMembers(workspaceId: string): Promise<
    Array<{
      membershipId: string;
      userId: string;
      role: "OWNER" | "EDITOR" | "VIEWER";
      email: string;
    }>
  > {
    const members = await this.db.workspaceMembership.findMany({
      where: { workspaceId, workspace: { archivedAt: null } },
      select: { id: true, userId: true, role: true, user: { select: { email: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return members.map((member) => ({
      membershipId: member.id,
      userId: member.userId,
      role: member.role,
      email: member.user.email,
    }));
  }

  public async create(userId: string, name: string): Promise<{ id: string; name: string }> {
    const workspace = await this.db.workspace.create({
      data: { name: name.trim(), memberships: { create: { userId, role: "OWNER" } } },
      select: { id: true, name: true },
    });
    await this.db.user.update({
      where: { id: userId },
      data: { defaultWorkspaceId: workspace.id },
    });
    return workspace;
  }

  public async list(
    userId: string,
  ): Promise<Array<{ id: string; name: string; archivedAt: Date | null }>> {
    return this.db.workspace.findMany({
      where: { archivedAt: null, memberships: { some: { userId } } },
      select: { id: true, name: true, archivedAt: true },
      orderBy: { createdAt: "asc" },
    });
  }

  public async update(
    context: WorkspaceContext,
    name: string,
  ): Promise<{ id: string; name: string }> {
    if (context.role !== "OWNER" && context.role !== "EDITOR")
      throw new ForbiddenException("Editor permission required");
    const result = await this.db.workspace.updateMany({
      where: {
        id: context.workspaceId,
        memberships: { some: { userId: context.userId, role: { in: ["OWNER", "EDITOR"] } } },
        archivedAt: null,
      },
      data: { name: name.trim() },
    });
    if (result.count !== 1) throw new NotFoundException("Workspace not found");
    return { id: context.workspaceId, name: name.trim() };
  }

  public async archive(context: WorkspaceContext): Promise<void> {
    if (context.role !== "OWNER") throw new ForbiddenException("Owner permission required");
    const result = await this.db.workspace.updateMany({
      where: {
        id: context.workspaceId,
        memberships: { some: { userId: context.userId, role: "OWNER" } },
        archivedAt: null,
      },
      data: { archivedAt: new Date() },
    });
    if (result.count !== 1) throw new NotFoundException("Workspace not found");
  }
}
