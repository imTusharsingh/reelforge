import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Injectable } from "@nestjs/common";
import { reservationCents, type VideoOptions, type MediaInput } from "@reelforge/ai-providers";
import { MediaReceiptSchema } from "@reelforge/contracts";
import type { ShotSpec } from "@reelforge/contracts";
import { SpawnProcessRunner } from "../composition/composition.engine.js";
import { keyframeKey } from "../runs/run-outcomes.js";
import { json, type Context, type Run } from "../runs/runs.types.js";
import { MediaAccess } from "./media-access.js";
import { MediaJobs } from "./media-jobs.js";
import { MediaPorts } from "./media-ports.js";
import { MEDIA_OVERHEAD } from "./media-prices.js";
@Injectable()
export class MediaFrames {
  public constructor(
    private readonly access: MediaAccess,
    private readonly jobs: MediaJobs,
    private readonly ports: MediaPorts,
    private readonly runner: SpawnProcessRunner,
  ) {}
  public async prepare(context: Context, run: Run, shot: ShotSpec): Promise<VideoOptions | null> {
    const ports = await this.ports.get(context);
    const refs = await this.ports.references(context, shot);
    const frame = await this.jobs.tick(
      context,
      run,
      keyframeKey(shot),
      ports.image,
      { prompt: shot.keyframePrompt, references: refs },
      reservationCents({ currency: "USD", microUsd: MEDIA_OVERHEAD.imageMicroUsd }),
      process.env.GEMINI_IMAGE_MODEL ?? "",
      "art-director:v2",
    );
    if (!frame) return null;
    const keyframe = await this.inline(context, frame.artifact);
    let firstFrame = keyframe;
    const from = shot.firstFrameFrom;
    if (from && "previousShotOrdinal" in from) {
      const previous = await this.access.runs.store.scoped(context).videoRunStep.findFirst({
        where: { runId: run.id, key: `shot-${from.previousShotOrdinal}`, state: "SUCCEEDED" },
        orderBy: { attempt: "desc" },
      });
      if (!previous) return null;
      const artifact = this.access.artifacts
        .descriptors(previous.output)
        .find((item) => item.kind === "clips");
      if (!artifact) throw new Error("Continuity source clip unavailable");
      firstFrame = await this.lastFrame(context, run, from.previousShotOrdinal, artifact);
    } else if (from)
      firstFrame = (await this.ports.references(context, { references: [from] }))[0]!;
    const extension = this.extension(shot);
    if (extension.extension) {
      const owner = await this.access.runs.store.scoped(context).videoRunStep.findFirst({
        where: {
          runId: run.id,
          providerJobId: extension.extension.providerJobId,
          key: { startsWith: "shot-" },
          state: "SUCCEEDED",
        },
      });
      if (!owner) throw new Error("Extension must pin a completed clip from this run");
      const output = owner.output as Record<string, unknown>;
      const receipt = MediaReceiptSchema.parse(output.receipt);
      if (
        Math.abs(
          (receipt.providerDurationSeconds ?? receipt.seconds) -
            extension.extension.previousSeconds,
        ) > 0.001
      )
        throw new Error("Extension duration must match the pinned provider clip");
    }
    return { firstFrame, ...(from ? { lastFrame: keyframe } : {}), ...extension };
  }
  public async extensionTail(body: Buffer, from: number): Promise<Buffer> {
    const root = await mkdtemp(join(tmpdir(), "reelforge-extension-"));
    try {
      const source = join(root, "extended.mp4"),
        target = join(root, "tail.mp4");
      await writeFile(source, body);
      const result = await this.runner.run({
        executable: "ffmpeg",
        argv: [
          "-nostdin",
          "-y",
          "-i",
          source,
          "-ss",
          String(from),
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-r",
          "24",
          "-c:a",
          "aac",
          target,
        ],
        signal: AbortSignal.timeout(120000),
      });
      if (result.exitCode) throw new Error("Extension tail extraction failed");
      const tail = await readFile(target);
      if (!tail.length) throw new Error("Extension tail is empty");
      return tail;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  public extension(shot: ShotSpec): Pick<VideoOptions, "extension"> {
    // Extension is an explicit, persisted V4 continuity note, never inferred from arbitrary text.
    const note = shot.continuityNotes.find((value) => value.startsWith("extension:"));
    if (!note) return {};
    const parsed: unknown = JSON.parse(note.slice("extension:".length));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("providerJobId" in parsed) ||
      typeof parsed.providerJobId !== "string" ||
      !("previousSeconds" in parsed) ||
      typeof parsed.previousSeconds !== "number"
    )
      throw new Error("Invalid extension pin");
    return {
      extension: { providerJobId: parsed.providerJobId, previousSeconds: parsed.previousSeconds },
    };
  }
  private async inline(
    context: Context,
    asset: { objectKey: string; checksumSha256: string; contentType?: string },
  ): Promise<MediaInput> {
    return {
      type: "image",
      mime_type: asset.contentType ?? "image/png",
      data: (await this.jobs.bytes(context, asset)).toString("base64"),
    };
  }
  private async extractFrame(source: string, target: string): Promise<void> {
    const result = await this.runner.run({
      executable: "ffmpeg",
      argv: [
        "-nostdin",
        "-y",
        "-sseof",
        "-1",
        "-i",
        source,
        "-vf",
        "reverse",
        "-frames:v",
        "1",
        "-update",
        "1",
        target,
      ],
      signal: AbortSignal.timeout(30000),
    });
    if (result.exitCode) throw new Error("Continuity frame extraction failed");
  }
  private async lastFrame(
    context: Context,
    run: Run,
    ordinal: number,
    clip: { objectKey: string; checksumSha256: string },
  ): Promise<MediaInput> {
    const db = this.access.runs.store.scoped(context),
      key = `local:last-frame:${ordinal}:${clip.checksumSha256}`;
    const previous = await db.videoRunStep.findFirst({
      where: { runId: run.id, key, state: "SUCCEEDED" },
    });
    if (previous)
      return this.inline(context, this.access.artifacts.descriptors(previous.output)[0]!);
    const root = await mkdtemp(join(tmpdir(), "reelforge-frame-"));
    try {
      const source = join(root, "clip.mp4"),
        target = join(root, "last.png");
      await writeFile(source, await this.jobs.bytes(context, clip));
      await this.extractFrame(source, target);
      const artifact = await this.access.artifacts.put(
        context,
        "keyframes",
        await readFile(target),
        "image/png",
      );
      await db.videoRunStep.upsert({
        where: {
          workspaceId_runId_key_attempt: {
            workspaceId: context.workspaceId,
            runId: run.id,
            key,
            attempt: 1,
          },
        },
        create: {
          workspaceId: context.workspaceId,
          runId: run.id,
          key,
          attempt: 1,
          idempotencyKey: `${run.id}:${key}:1`,
          input: {},
          state: "SUCCEEDED",
          output: json({ storageArtifacts: [artifact] }),
        },
        update: {},
      });
      return this.inline(context, artifact);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
