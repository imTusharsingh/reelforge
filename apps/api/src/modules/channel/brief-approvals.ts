import { Injectable } from "@nestjs/common";
import type { WorkspaceContext } from "../identity/identity.types.js";

/** V3 seam: fail closed until its channel approval-count API is available.
 * Never infer approvals from uploads, run state, or workspace totals. */
@Injectable()
export class BriefApprovals {
  public async count(_context: WorkspaceContext, _channelId: string): Promise<number> {
    void _context;
    void _channelId;
    return 0;
  }
}
