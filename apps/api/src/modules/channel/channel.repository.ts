import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { ChannelStatus } from "./channel.types.js";

export class ChannelRepository {
  public constructor(private readonly db: Database) {}

  public findMany(context: WorkspaceContext): Promise<unknown> {
    return this.db.channel.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: { createdAt: "asc" },
    });
  }

  public find(context: WorkspaceContext, id: string): Promise<{ status: ChannelStatus } | null> {
    return this.db.channel.findFirst({
      where: { workspaceId: context.workspaceId, id },
      include: { activeSnapshot: true },
    });
  }
}
