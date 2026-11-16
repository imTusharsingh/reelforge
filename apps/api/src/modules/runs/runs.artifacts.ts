import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import { ArtifactSchema, type Artifact, type Context } from "./runs.types.js";
import { RunsStore } from "./runs.store.js";

@Injectable()
export class RunsArtifacts {
  private readonly signingKey = randomBytes(32);
  public constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly store: RunsStore,
  ) {}
  public async put(
    context: Context,
    kind: Artifact["kind"],
    body: Buffer,
    contentType: string,
  ): Promise<Artifact> {
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    // Distinct retention namespaces prevent draft cleanup deleting a final with identical bytes.
    const permanent = kind === "final" || kind === "manifest";
    const expiresAt = permanent ? null : new Date(Date.now() + 14 * 86400000).toISOString();
    const objectKey = `runs/${permanent ? "permanent" : `draft/${Date.parse(expiresAt!)}`}/${checksumSha256}`;
    await this.storage.putObject({
      workspaceId: context.workspaceId,
      objectKey,
      body,
      contentType,
    });
    return ArtifactSchema.parse({
      kind,
      checksumSha256,
      objectKey,
      contentType,
      byteSize: body.length,
      expiresAt,
    });
  }
  public sign(context: Context, runId: string, stepId: string, artifact: Artifact): string {
    const expires = Date.now() + 5 * 60000;
    const path = `/api/v1/runs/${runId}/artifacts/${stepId}/${artifact.checksumSha256}`;
    const signature = this.mac(`${context.workspaceId}:${path}:${expires}`);
    return `${path}?workspaceId=${context.workspaceId}&expires=${expires}&signature=${signature}`;
  }
  public async get(
    context: Context,
    runId: string,
    stepId: string,
    checksum: string,
    expires: number,
    signature: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    const path = `/api/v1/runs/${runId}/artifacts/${stepId}/${checksum}`;
    const expected = this.mac(`${context.workspaceId}:${path}:${expires}`);
    if (
      !Number.isSafeInteger(expires) ||
      expires < Date.now() ||
      expires > Date.now() + 5 * 60000 ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new ForbiddenException("Invalid artifact signature");
    await this.store.get(context, runId);
    const step = await this.store
      .scoped(context)
      .videoRunStep.findFirst({ where: { id: stepId, runId } });
    const artifacts = this.descriptors(step?.output);
    const artifact = artifacts.find((item) => item.checksumSha256 === checksum);
    if (!artifact || (artifact.expiresAt && Date.parse(artifact.expiresAt) < Date.now()))
      throw new NotFoundException("Artifact unavailable");
    const body = await this.storage.getObject({
      workspaceId: context.workspaceId,
      objectKey: artifact.objectKey,
    });
    if (createHash("sha256").update(body).digest("hex") !== checksum)
      throw new Error("Artifact checksum mismatch");
    return { body, contentType: artifact.contentType };
  }
  public async sweep(context: Context): Promise<void> {
    const db = this.store.scoped(context);
    const steps = await db.videoRunStep.findMany({ where: {} });
    for (const step of steps) {
      const artifacts = z.array(ArtifactSchema).safeParse(this.descriptors(step.output));
      if (!artifacts.success) continue;
      const expired = artifacts.data.filter(
        (a) => a.expiresAt && Date.parse(a.expiresAt) <= Date.now(),
      );
      for (const artifact of expired)
        await this.storage.deleteObject({
          workspaceId: context.workspaceId,
          objectKey: artifact.objectKey,
        });
    }
  }
  public descriptors(output: unknown): Artifact[] {
    const parsed = z
      .object({ storageArtifacts: z.array(ArtifactSchema) })
      .passthrough()
      .safeParse(output);
    return parsed.success ? parsed.data.storageArtifacts : [];
  }
  public views(context: Context, runId: string, stepId: string, value: unknown): unknown[] {
    const artifacts = z.array(ArtifactSchema).safeParse(value);
    if (!artifacts.success) return [];
    return artifacts.data
      .filter((a) => !a.expiresAt || Date.parse(a.expiresAt) > Date.now())
      .map((a) => ({ ...a, url: this.sign(context, runId, stepId, a) }));
  }
  private mac(value: string): string {
    return createHmac("sha256", this.signingKey).update(value).digest("hex");
  }
}
