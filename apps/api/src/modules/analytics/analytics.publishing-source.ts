import { Injectable } from "@nestjs/common";
import { PublishedPostRecordSchema, type PublishedPostRecord } from "@reelforge/contracts";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { PublishingService } from "../publishing/publishing.service.js";
import type { PublishedPostSource } from "./analytics.ports.js";

@Injectable()
export class PublishingPublishedPostSource implements PublishedPostSource {
  public constructor(private readonly publishing: PublishingService) {}

  public isConfigured(): boolean {
    return true;
  }

  public async listPublishedRecords(
    context: WorkspaceContext,
    after: string | null,
    limit: number,
    afterId: string | null,
  ): Promise<readonly PublishedPostRecord[]> {
    const records = await this.publishing.listPublishedRecords(context, after, limit, afterId);
    return records.map((record) => PublishedPostRecordSchema.parse(record));
  }
}
