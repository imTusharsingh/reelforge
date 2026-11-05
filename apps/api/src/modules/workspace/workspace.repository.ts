import type { Database, WorkspaceContext } from "../identity/identity.types.js";

/** All workspace-owned lookups include the verified tenant key and membership. */
export class WorkspaceRepository {
  public constructor(private readonly db: Database) {}

  public findById(
    context: WorkspaceContext,
    workspaceId: string,
  ): ReturnType<Database["workspace"]["findFirst"]> {
    return this.db.workspace.findFirst({
      where: {
        id: workspaceId,
        memberships: { some: { workspaceId: context.workspaceId, userId: context.userId } },
      },
    });
  }
}
