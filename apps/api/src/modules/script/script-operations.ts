import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { resolveScriptGenre } from "./script-genre.js";
import {
  parseScriptWriteDocument,
  validateGenrePolicy,
  validateScript,
} from "./script.validation.js";
import { ScriptLedger } from "./script-ledger.js";
@Injectable()
export class ScriptOperations extends ScriptLedger {
  public async list(context: WorkspaceContext, page = 1): Promise<unknown> {
    const rows = await this.db.script.findMany({
      where: { workspaceId: context.workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * 50,
      take: 51,
      include: {
        revisions: {
          orderBy: { revision: "desc" },
          take: 1,
          select: { revision: true, document: true, createdAt: true },
        },
      },
    });
    return { items: rows.slice(0, 50), nextPage: rows.length > 50 ? page + 1 : null };
  }
  public async revisions(context: WorkspaceContext, id: string, page = 1): Promise<unknown> {
    const script = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      select: { id: true },
    });
    if (!script) throw new NotFoundException("Script not found");
    const rows = await this.db.scriptRevision.findMany({
      where: { workspaceId: context.workspaceId, scriptId: id },
      orderBy: { revision: "desc" },
      skip: (page - 1) * 50,
      take: 51,
      select: {
        id: true,
        revision: true,
        document: true,
        createdAt: true,
        modelVersion: true,
        promptVersion: true,
      },
    });
    return { items: rows.slice(0, 50), nextPage: rows.length > 50 ? page + 1 : null };
  }
  public async get(context: WorkspaceContext, id: string): Promise<unknown> {
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: {
        revisions: { orderBy: { revision: "desc" }, take: 1 },
        snapshot: { include: { idea: { select: { status: true } } } },
      },
    });
    if (!row) throw new NotFoundException("Script not found");
    return row;
  }
  public async revise(
    context: WorkspaceContext,
    id: string,
    body: unknown,
    expectedRevision: number,
  ): Promise<unknown> {
    this.editor(context);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new BadRequestException("expectedRevision must be a positive integer");
    const document = parseScriptWriteDocument(body);
    validateScript(document);
    const [genre, row] = await Promise.all([
      resolveScriptGenre(this.db, context.workspaceId, document.metadata.genre),
      this.db.script.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
        select: { currentRevision: true, status: true, snapshot: { select: { references: true } } },
      }),
    ]);
    if (!row) throw new NotFoundException("Script not found");
    validateGenrePolicy(document, genre, row.snapshot.references);
    if (row.status === "APPROVED") throw new ConflictException("Approved scripts are immutable");
    if (row.currentRevision !== expectedRevision)
      throw new ConflictException("Script changed since the caller observed it");
    await this.db.$transaction(async (tx) => {
      const claimed = await tx.script.updateMany({
        where: {
          workspaceId: context.workspaceId,
          id,
          currentRevision: expectedRevision,
          status: row.status,
        },
        data: { currentRevision: { increment: 1 }, status: "REVISION_PENDING" },
      });
      if (claimed.count !== 1)
        throw new ConflictException("Script revision changed concurrently; retry");
      await tx.scriptRevision.create({
        data: {
          workspaceId: context.workspaceId,
          scriptId: id,
          revision: expectedRevision + 1,
          document,
          createdByUserId: context.userId,
        },
      });
    });
    return this.get(context, id);
  }
  public async approve(
    context: WorkspaceContext,
    id: string,
    expectedRevision: number,
  ): Promise<unknown> {
    this.editor(context);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new BadRequestException("expectedRevision must be a positive integer");
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: {
        revisions: { orderBy: { revision: "desc" }, take: 1 },
        snapshot: { include: { idea: { select: { status: true } } } },
      },
    });
    if (!row) throw new NotFoundException("Script not found");
    if (row.currentRevision !== expectedRevision)
      throw new ConflictException("Script changed since the caller observed it");
    if (
      !row.revisions[0] ||
      row.snapshot.checksumSha256 !== row.approvedIdeaChecksum ||
      row.snapshot.idea.status !== "APPROVED"
    ) {
      throw new ConflictException("Approved idea snapshot is stale or no longer approved");
    }
    // The conditional claim binds approval to exactly the revision validated above.
    if (row.status === "APPROVED") throw new ConflictException("Script already approved");
    const claimed = await this.db.script.updateMany({
      where: {
        workspaceId: context.workspaceId,
        id,
        currentRevision: expectedRevision,
        status: row.status,
      },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new ConflictException("Script changed concurrently; retry approval");
    const exported = await this.exportApproved(context, id);
    if (
      !exported ||
      typeof exported !== "object" ||
      (exported as { revision?: number }).revision !== row.currentRevision
    ) {
      throw new ConflictException("Script changed concurrently; retry approval");
    }
    return exported;
  }
  public async exportApproved(context: WorkspaceContext, id: string): Promise<unknown> {
    const row = await this.db.script.findUnique({
      where: { workspaceId_id: { workspaceId: context.workspaceId, id } },
      include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
    if (!row || row.status !== "APPROVED") {
      throw new ConflictException("Only approved scripts can be exported");
    }
    return {
      scriptId: row.id,
      revision: row.currentRevision,
      approvedIdeaSnapshotId: row.approvedIdeaSnapshotId,
      document: row.revisions[0]?.document,
    };
  }
  public async providerHealth(
    context: WorkspaceContext,
    providerId: string,
    capabilityId: string,
  ): Promise<unknown> {
    this.editor(context);
    return this.registry.healthCheck(providerId, capabilityId);
  }
}
