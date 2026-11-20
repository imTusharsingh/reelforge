import { z } from "zod";
import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { MediaReceiptSchema, type MediaReceipt } from "@reelforge/contracts";
import { type MediaJobPort, type ClipArtifact, ProviderFailure } from "@reelforge/ai-providers";
import { STORAGE_PORT, type StoragePort } from "../asset/storage/storage.port.js";
import {
  ArtifactSchema,
  type Context,
  type Run,
  type Step,
  type Artifact,
} from "../runs/runs.types.js";
import { MediaAccess } from "./media-access.js";
import { MediaAccounts } from "./media-accounts.js";
type CompletedMedia = { receipt: MediaReceipt; artifact: Artifact };
@Injectable()
export class MediaJobs {
  public constructor(
    private readonly access: MediaAccess,
    private readonly accounts: MediaAccounts,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}
  public async tick<T>(
    context: Context,
    run: Run,
    key: string,
    port: MediaJobPort<T>,
    spec: T,
    cost: number,
    modelId: string,
    promptVersion: string,
    seconds = 0,
  ): Promise<CompletedMedia | null> {
    const db = this.access.runs.store.scoped(context);
    const previous = await db.videoRunStep.findFirst({
      where: { runId: run.id, key: `media:${key}` },
      orderBy: { attempt: "desc" },
    });
    let step = previous && !this.accounts.abandoned(previous) ? previous : null;
    if (step?.state === "SUCCEEDED") return this.completed(step.output);
    if (step?.state === "CANCELLED")
      throw new ConflictException("MEDIA_NOT_DISPATCHED: new attempt required");
    if (step && !step.providerJobId) return this.accounts.reconcilePending(context, step);
    if (!step) {
      const claimed = await this.accounts.begin(context, run, `media:${key}`, spec, cost, modelId);
      await this.accounts.prepare(context, run, claimed, modelId);
      try {
        const job = await this.accounts.dispatch(context, claimed, () =>
          port.submit(spec, claimed.idempotencyKey),
        );
        await db.videoRunStep.updateMany({
          where: { id: claimed.id },
          data: { providerJobId: job.providerJobId, state: "WAITING_EXTERNAL" },
        });
        step = { ...claimed, providerJobId: job.providerJobId };
      } catch (error) {
        if (error instanceof ProviderFailure && !error.dispatched)
          await this.accounts.cancelUndispatched(context, claimed);
        throw error;
      }
    }
    return this.collect(context, key, port, step, modelId, promptVersion, seconds);
  }
  private async collect<T>(
    context: Context,
    key: string,
    port: MediaJobPort<T>,
    step: Step,
    modelId: string,
    promptVersion: string,
    seconds: number,
  ): Promise<CompletedMedia | null> {
    const status = await port.poll(step.providerJobId!);
    if (status === "queued" || status === "running") return null;
    if (status !== "succeeded") throw new ConflictException(`PROVIDER_${status.toUpperCase()}`);
    const media = await port.fetch(step.providerJobId!, seconds || undefined);
    const body = await this.bytes(context, media);
    const artifact = await this.access.artifacts.put(context, mediaKind(key), body, media.mimeType);
    const receipt = MediaReceiptSchema.parse({
      key,
      providerId: "gemini",
      providerJobId: step.providerJobId,
      modelId,
      promptVersion,
      seconds: media.billedSeconds ?? seconds,
      costMinor: step.costMinor,
      objectKey: artifact.objectKey,
      checksumSha256: artifact.checksumSha256,
      mimeType: media.mimeType,
    });
    const output: CompletedMedia = { receipt, artifact };
    await this.accounts.complete(context, step, output);
    return output;
  }
  public async wait<T>(
    context: Context,
    run: Run,
    key: string,
    port: MediaJobPort<T>,
    spec: T,
    cost: number,
    modelId: string,
    promptVersion: string,
    seconds = 0,
  ): Promise<CompletedMedia> {
    // Only background stage handlers call wait; shot jobs use tick and BullMQ's delayed child.
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await this.tick(
        context,
        run,
        key,
        port,
        spec,
        cost,
        modelId,
        promptVersion,
        seconds,
      );
      if (result) return result;
      await new Promise<void>((resolve) => setTimeout(resolve, 12000));
    }
    throw new ConflictException("RECONCILE_REQUIRED: provider still processing");
  }
  public async bytes(
    context: Context,
    media: Pick<ClipArtifact, "objectKey" | "checksumSha256">,
  ): Promise<Buffer> {
    const body = await this.storage.getObject({
      workspaceId: context.workspaceId,
      objectKey: media.objectKey,
    });
    if (createHash("sha256").update(body).digest("hex") !== media.checksumSha256)
      throw new Error("Media checksum mismatch");
    return body;
  }
  public completed(value: unknown): CompletedMedia {
    return z
      .object({ result: z.object({ receipt: MediaReceiptSchema, artifact: ArtifactSchema }) })
      .parse(value).result;
  }
}

function mediaKind(key: string): "keyframes" | "refs" | "music" | "narration" {
  const kind = key.startsWith("keyframe")
    ? "keyframes"
    : key.startsWith("reference:")
      ? "refs"
      : key === "music"
        ? "music"
        : "narration";
  return kind;
}
