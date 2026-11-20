import { Inject, Injectable } from "@nestjs/common";
import { foundationWorkspaceGuard } from "@reelforge/database";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";

export function countApprovedShorts(
  scoped: ReturnType<typeof foundationWorkspaceGuard>,
  channelId: string,
): Promise<number> {
  return scoped.videoRun.count({
    where: { channelId, events: { some: { type: "approved" } } },
  });
}

@Injectable()
export class BriefApprovals {
  public constructor(@Inject("DATABASE") db: Database) {
    this.count = (context, channelId): Promise<number> =>
      countApprovedShorts(foundationWorkspaceGuard(db, context), channelId);
  }

  public readonly count: (context: WorkspaceContext, channelId: string) => Promise<number>;
}
