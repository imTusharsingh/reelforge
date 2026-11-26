import { refreshAssemblyManifests } from "../composition/assembly-receipts.js";
import {
  deliveryChunkHashes,
  maxDeliveryBytes,
  readMediaBody,
  type MediaResponseOptions,
} from "../asset/content-delivery.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { z } from "zod";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import {
  ArtifactSchema,
  RECOVERY_PRINCIPAL,
  type Artifact,
  type Context,
  type Step,
} from "./runs.types.js";
import { verifyLargeLegacyArtifact, type VerifiedArtifactFile } from "./legacy-artifact.js";
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
    if (body.byteLength > maxDeliveryBytes)
      throw new PayloadTooLargeException("Run artifact exceeds 128 MiB");
    const checksumSha256 = createHash("sha256").update(body).digest("hex");
    // Distinct retention namespaces prevent draft cleanup deleting a final with identical bytes.
    const permanent = kind === "final" || kind === "manifest";
    const expiresAt = permanent ? null : new Date(Date.now() + 14 * 86400000).toISOString();
    const objectKey = `runs/${permanent ? "permanent" : `draft/${Date.parse(expiresAt!)}`}/${checksumSha256}`;
    const artifact = ArtifactSchema.parse({
      kind,
      checksumSha256,
      objectKey,
      contentType,
      byteSize: body.length,
      deliveryChunkHashes: deliveryChunkHashes(body),
      expiresAt,
    });
    await this.storage.putObject({
      workspaceId: context.workspaceId,
      objectKey,
      body,
      contentType,
    });
    return artifact;
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
    options: MediaResponseOptions = {},
  ): Promise<{
    body: Buffer;
    bodyOffset: number | undefined;
    contentType: string;
    byteSize: number;
    file?: VerifiedArtifactFile;
  }> {
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
    const step = await this.deliveryStep(context, runId, stepId, checksum);
    const artifacts = this.descriptors(step?.output);
    const artifact = artifacts.find((item) => item.checksumSha256 === checksum);
    if (!artifact || (artifact.expiresAt && Date.parse(artifact.expiresAt) < Date.now()))
      throw new NotFoundException("Artifact unavailable");
    if (artifact.byteSize > maxDeliveryBytes) return this.getHistorical(context, artifact, options);
    const { body, bodyOffset, legacyHashes } = await readMediaBody(
      {
        storage: this.storage,
        workspaceId: context.workspaceId,
        objectKey: artifact.objectKey,
        byteSize: artifact.byteSize,
        checksumSha256: checksum,
        label: "Artifact",
      },
      options,
      artifact.deliveryChunkHashes,
    );
    if (legacyHashes && step)
      await this.indexLegacy(context, step, artifacts, artifact, legacyHashes);
    const { contentType, byteSize } = artifact;
    return { body, bodyOffset, contentType, byteSize };
  }
  private async deliveryStep(
    context: Context,
    runId: string,
    stepId: string,
    checksum: string,
  ): Promise<Step | null> {
    const readStep = (): Promise<Step | null> =>
      this.store.scoped(context).videoRunStep.findFirst({ where: { id: stepId, runId } });
    let step = await readStep();
    if (
      this.descriptors(step?.output).some(
        (item) => item.kind === "manifest" && item.checksumSha256 === checksum,
      )
    ) {
      await this.refreshManifests(context, runId);
      step = await readStep();
    }
    return step;
  }
  private async getHistorical(
    context: Context,
    artifact: Artifact,
    options: MediaResponseOptions,
  ): ReturnType<RunsArtifacts["get"]> {
    const file = await verifyLargeLegacyArtifact(
      this.storage,
      context.workspaceId,
      artifact,
      options,
    );
    return {
      byteSize: artifact.byteSize,
      contentType: artifact.contentType,
      body: Buffer.alloc(0),
      bodyOffset: undefined,
      ...(file ? { file } : {}),
    };
  }
  private async indexLegacy(
    context: Context,
    step: Step,
    artifacts: Artifact[],
    artifact: Artifact,
    legacyHashes: string[],
  ): Promise<void> {
    const output = step.output;
    if (output && typeof output === "object" && !Array.isArray(output)) {
      // Only write digests derived from bytes verified against the immutable descriptor.
      const indexer = this.store.scoped({ ...context, userId: RECOVERY_PRINCIPAL, role: "OWNER" });
      await indexer.videoRunStep.updateMany({
        where: { id: step.id, runId: step.runId, updatedAt: step.updatedAt },
        data: {
          output: {
            ...output,
            storageArtifacts: artifacts.map((item) =>
              item === artifact ? { ...item, deliveryChunkHashes: legacyHashes } : item,
            ),
          },
        },
      });
    }
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
  public async refreshManifests(context: Context, runId: string): Promise<void> {
    await refreshAssemblyManifests(
      this.store,
      this,
      this.storage,
      { ...context, userId: RECOVERY_PRINCIPAL, role: "OWNER" },
      runId,
    );
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
      .map((a) => ({
        kind: a.kind,
        checksumSha256: a.checksumSha256,
        objectKey: a.objectKey,
        contentType: a.contentType,
        byteSize: a.byteSize,
        expiresAt: a.expiresAt,
        url: this.sign(context, runId, stepId, a),
      }));
  }
  private mac(value: string): string {
    return createHmac("sha256", this.signingKey).update(value).digest("hex");
  }
}
