import { randomUUID, createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { ReferenceAsset } from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
@Injectable()
export class PlanningCharacterService {
  public constructor(@Inject("DATABASE") private readonly db: Database) {}
  public async publish(
    context: WorkspaceContext,
    references: readonly ReferenceAsset[],
    voiceId: string,
    styleNotes: string,
  ): Promise<string> {
    if (context.role === "VIEWER") throw new Error("Editor permission required");
    const id = randomUUID();
    const profile = {
      name: "Channel character",
      description: styleNotes,
      personality: {},
      voicePreference: { voiceId },
      visualInvariants: { styleNotes },
      variationRules: {},
    };
    const assets = references.map((ref) => ({ assetId: ref.assetId, version: ref.assetVersion }));
    const checksumSha256 = createHash("sha256")
      .update(JSON.stringify({ profile, assets }))
      .digest("hex");
    return this.db.$transaction(async (tx) => {
      const character = await tx.character.create({
        data: {
          id,
          workspaceId: context.workspaceId,
          ...profile,
          referenceAssets: assets,
          status: "PUBLISHED",
        },
      });
      const version = await tx.characterVersion.create({
        data: {
          workspaceId: context.workspaceId,
          characterId: character.id,
          version: 1,
          status: "PUBLISHED",
          profile,
          referenceAssets: assets,
          checksumSha256,
          createdByUserId: context.userId,
          publishedAt: new Date(),
        },
      });
      await tx.character.update({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        data: { activeVersionId: version.id },
      });
      return version.id;
    });
  }
}
