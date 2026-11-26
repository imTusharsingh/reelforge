import { z } from "zod";
import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { MediaReceiptSchema, type MediaReceipt } from "@reelforge/contracts";
import {
  type MediaJobPort,
  type ClipArtifact,
  ProviderFailure,
  SubmissionRefused,
} from "@reelforge/ai-providers";
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
class TerminalMediaJobFailure extends ConflictException {}
export class MediaChecksumMismatch extends Error {}

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
    assertLocked?: () => Promise<void>,
  ): Promise<CompletedMedia | null> {
    const db = this.access.runs.store.scoped(context);
    const previous = await db.videoRunStep.findFirst({
      where: { runId: run.id, key: `media:${key}` },
      orderBy: { attempt: "desc" },
    });
    let step = previous && !this.accounts.abandoned(previous) ? previous : null;
    if (step?.state === "SUCCEEDED") return this.completed(step.output);
    if (step?.state === "FAILED") throw new ConflictException("Media provider job failed");
    if (step?.state === "CANCELLED")
      throw new ConflictException("MEDIA_NOT_DISPATCHED: new attempt required");
    if (step && !step.providerJobId) step = await this.recoverIntent(context, step);
    if (!step) {
      const claimed = await this.accounts.begin(context, run, `media:${key}`, spec, cost, modelId);
      await this.accounts.prepare(context, run, claimed, modelId);
      try {
        const job = await this.accounts.dispatch(
          context,
          claimed,
          () => port.submit(spec, claimed.idempotencyKey),
          assertLocked,
        );
        await this.access.paid.recordJob(context, claimed, job.providerJobId);
        step = await this.access.runs.attachJob(context, claimed, job.providerJobId);
      } catch (error) {
        if (
          error instanceof SubmissionRefused ||
          (error instanceof ProviderFailure && !error.dispatched)
        ) {
          if (
            error instanceof SubmissionRefused ||
            ((key === "music" || key === "narration") &&
              ["INVALID", "REFUSAL", "NEEDS_HUMAN"].includes(error.kind))
          ) {
            const event = await this.access.paid.finalizeRejected(context, claimed, error);
            await this.access.runs.events?.publish(event);
          } else await this.accounts.cancelUndispatched(context, claimed);
        }
        throw error;
      }
    }
    return this.collect(context, key, port, step, promptVersion, seconds);
  }
  private async recoverIntent(context: Context, step: Step): Promise<Step | null> {
    if (await this.accounts.recoverUndispatched(context, step)) return null;
    const providerJobId = await this.access.paid.jobReceipt(context, step);
    if (!providerJobId) return this.accounts.reconcilePending(context, step);
    return this.access.runs.attachJob(context, step, providerJobId);
  }

  /** Drain only this admitted keyframe, including while its parent cannot start a shot. */
  public async recoverKeyframe<T>(
    context: Context,
    step: Step,
    port: MediaJobPort<T>,
  ): Promise<number | null> {
    const pending = step.providerJobId ? step : await this.recoverIntent(context, step);
    if (!pending) return null;
    const result = await this.collect(
      context,
      step.key.slice("media:".length),
      port,
      pending,
      "art-director:v2",
      0,
    );
    return result ? null : 12000;
  }

  /** Recover an existing audio admission without opening another intent. */
  public async drainAudio<T>(
    context: Context,
    step: Step,
    port: MediaJobPort<T>,
    seconds: number,
  ): Promise<void> {
    const pending = step.providerJobId ? step : await this.recoverIntent(context, step);
    if (!pending) return;
    const key = z.enum(["media:narration", "media:music"]).parse(step.key);
    try {
      await this.collect(
        context,
        key.slice(6),
        port,
        pending,
        key === "media:narration" ? "channel-narrator:v1" : "instrumental-bed:v1",
        seconds,
      );
    } catch (error) {
      if (!(error instanceof TerminalMediaJobFailure)) throw error;
    }
  }

  private async collect<T>(
    context: Context,
    key: string,
    port: MediaJobPort<T>,
    step: Step,
    promptVersion: string,
    seconds: number,
  ): Promise<CompletedMedia | null> {
    const status = await port.poll(step.providerJobId!);
    if (status === "queued" || status === "running") return null;
    if (status !== "succeeded") {
      const code = `PROVIDER_${status.toUpperCase()}`;
      const event = await this.access.paid.finalizeJobFailure(context, step, code);
      await this.access.runs.events?.publish(event);
      throw new TerminalMediaJobFailure(code);
    }
    const media = await port.fetch(step.providerJobId!, seconds || undefined);
    const body = await this.bytes(context, media);
    const artifact = await this.access.artifacts.put(context, mediaKind(key), body, media.mimeType);
    const receipt = MediaReceiptSchema.parse({
      key,
      providerId: "gemini",
      providerJobId: step.providerJobId,
      modelId: z.object({ modelId: z.string().min(1) }).parse(step.input).modelId,
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
    assertLocked?: () => Promise<void>,
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
        assertLocked,
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
      throw new MediaChecksumMismatch("Media checksum mismatch");
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
