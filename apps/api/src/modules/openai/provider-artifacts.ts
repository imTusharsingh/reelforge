import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactStore, ClipArtifact } from "@reelforge/ai-providers";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { MediaValidationError, type ProcessRunner } from "@reelforge/media";
import { SpawnProcessRunner } from "../composition/composition.engine.js";
const probeSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      width: z.number().optional(),
      height: z.number().optional(),
      r_frame_rate: z.string().optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional() }),
});
export class ProviderArtifacts implements ArtifactStore {
  public constructor(
    private readonly storage: StoragePort,
    private readonly workspaceId: string,
    private readonly runner: ProcessRunner = new SpawnProcessRunner(),
  ) {}
  public async save(
    input: Uint8Array,
    mimeType: string,
    trimSeconds?: number,
  ): Promise<Omit<ClipArtifact, "billedSeconds">> {
    validateInput(input, mimeType);
    const directory = await mkdtemp(join(tmpdir(), "reelforge-provider-"));
    try {
      const source = join(directory, "source");
      await writeFile(source, input);
      let body = Buffer.from(input);
      let path = source;
      if (trimSeconds !== undefined) {
        if (
          !Number.isFinite(trimSeconds) ||
          trimSeconds <= 0 ||
          trimSeconds > 120 ||
          !mimeType.startsWith("audio/")
        )
          throw new Error("Invalid music trim");
        path = join(directory, "trimmed.mp3");
        await this.execute("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-i",
          source,
          "-t",
          String(trimSeconds),
          "-vn",
          "-c:a",
          "libmp3lame",
          path,
        ]);
        body = await readFile(path);
        mimeType = "audio/mpeg";
      }
      const metadata = await this.probe(path, mimeType);
      const checksumSha256 = createHash("sha256").update(body).digest("hex");
      const objectKey = `providers/${checksumSha256}`;
      const stored = await this.storage.putObject({
        workspaceId: this.workspaceId,
        objectKey,
        body,
        contentType: mimeType,
      });
      if (stored.checksumSha256 !== checksumSha256 || stored.byteSize !== body.length)
        throw new Error("Stored provider media integrity mismatch");
      return { objectKey, checksumSha256, byteSize: body.length, mimeType, ...metadata };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async execute(
    executable: "ffmpeg" | "ffprobe",
    argv: readonly string[],
  ): Promise<{ stdout: string }> {
    const result = await this.runner.run({ executable, argv, signal: AbortSignal.timeout(30000) });
    if (result.exitCode !== 0) {
      if (executable === "ffprobe") throw new MediaValidationError("Provider media process failed");
      throw new Error("Provider media process failed");
    }
    return result;
  }
  private async probe(
    path: string,
    mimeType: string,
  ): Promise<{ durationSeconds: number; width: number; height: number; fps: number }> {
    const { stdout } = await this.execute("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ]);
    let probe: z.infer<typeof probeSchema>;
    try {
      probe = probeSchema.parse(JSON.parse(stdout) as unknown);
    } catch (cause) {
      throw new MediaValidationError("Invalid provider media probe report", { cause });
    }
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.some((stream) => stream.codec_type === "audio");
    const [numerator, denominator] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
    const fps = denominator ? numerator! / denominator : 0;
    const durationSeconds = Number(probe.format.duration ?? 0);
    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds < 0 ||
      !Number.isFinite(fps) ||
      (mimeType.startsWith("video/") && (!video || durationSeconds <= 0)) ||
      (mimeType.startsWith("audio/") && (!audio || durationSeconds <= 0)) ||
      (mimeType.startsWith("image/") && !video)
    )
      throw new MediaValidationError("Invalid probed provider media");
    return { durationSeconds, width: video?.width ?? 0, height: video?.height ?? 0, fps };
  }
}

function validateInput(input: Uint8Array, mimeType: string): void {
  if (
    !input.length ||
    input.length > 100 * 1024 * 1024 ||
    !["video/mp4", "image/png", "image/jpeg", "audio/wav", "audio/mpeg"].includes(mimeType)
  )
    throw new MediaValidationError("Invalid provider media");
}
