import { ConflictException, GoneException, Inject, Injectable } from "@nestjs/common";
import type { SceneMediaCapabilityCatalog, SceneMediaJobList } from "@reelforge/contracts";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { SceneMediaHistory } from "./scene-media.history.js";
import { SceneMediaAssignment } from "./scene-media.assignment.js";
import { isCompletePackage, providerEnvironment } from "./scene-media.validation.js";
import type { SceneMediaPackage } from "./scene-media.types.js";
/** @deprecated Legacy readers and C3 assignment retained until T2. V5 removes all synchronous generation. */
@Injectable()
export class SceneMediaService {
  private readonly history: SceneMediaHistory;
  private readonly assignment: SceneMediaAssignment;
  public constructor(@Inject("DATABASE") db: Database) {
    this.history = new SceneMediaHistory(db);
    this.assignment = new SceneMediaAssignment(db);
  }
  public get(context: WorkspaceContext, jobId: string): Promise<SceneMediaPackage> {
    return this.history.get(context, jobId);
  }
  public list(context: WorkspaceContext, query: unknown): Promise<SceneMediaJobList> {
    return this.history.list(context, query);
  }
  public async exportPackage(context: WorkspaceContext, jobId: string): Promise<SceneMediaPackage> {
    const pkg = await this.get(context, jobId);
    if (!isCompletePackage(pkg)) throw new ConflictException("Scene media package is incomplete");
    return pkg;
  }
  public async assignAsset(
    context: WorkspaceContext,
    jobId: string,
    sceneId: string,
    body: unknown,
  ): Promise<SceneMediaPackage> {
    await this.assignment.assign(context, jobId, sceneId, body);
    return this.get(context, jobId);
  }
  public async capabilities(context: WorkspaceContext): Promise<SceneMediaCapabilityCatalog> {
    return {
      workspaceId: context.workspaceId,
      generatedAt: new Date().toISOString(),
      environment: providerEnvironment(),
      capabilities: [],
    };
  }
  public async providerHealth(
    context: WorkspaceContext,
    providerId: string,
    capabilityId: string,
  ): Promise<unknown> {
    void context;
    void providerId;
    void capabilityId;
    return { healthy: false, reason: "LEGACY_RETIRED" };
  }
  /** Compatibility for the deprecated M16 dispatcher, with no executable production path. */
  public async create(context: WorkspaceContext, body: unknown): Promise<SceneMediaPackage> {
    void context;
    void body;
    throw new GoneException(
      "Use pipeline.v2 VideoRun jobs; synchronous generation was removed in V5",
    );
  }
}
