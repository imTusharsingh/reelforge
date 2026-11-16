import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ProviderArtifacts } from "./provider-artifacts.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
const execute = promisify(execFile);
describe("provider artifact integrity and FFmpeg processing", () => {
  it("probes, hashes and stores real fixture media; trims instrumental music", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-fixture-"));
    const putObject = vi.fn(async (input: Parameters<StoragePort["putObject"]>[0]) => ({
      objectKey: input.objectKey,
      byteSize: input.body.length,
      checksumSha256: createHash("sha256").update(input.body).digest("hex"),
    }));
    const storage: StoragePort = { putObject, getObject: vi.fn(), deleteObject: vi.fn() };
    const store = new ProviderArtifacts(storage, "workspace");
    try {
      const video = join(directory, "fixture.mp4");
      const music = join(directory, "fixture.wav");
      await execute("ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=72x128:r=24:d=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        video,
      ]);
      await execute("ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        music,
      ]);
      const clip = await store.save(await readFile(video), "video/mp4");
      expect(clip).toMatchObject({ width: 72, height: 128, fps: 24, durationSeconds: 1 });
      expect(clip.objectKey).toBe(`providers/${clip.checksumSha256}`);
      const trimmed = await store.save(await readFile(music), "audio/wav", 1);
      expect(trimmed.durationSeconds).toBeGreaterThanOrEqual(1);
      expect(trimmed.durationSeconds).toBeLessThan(1.2);
      expect(putObject).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: "workspace", contentType: "audio/mpeg" }),
      );
      await expect(store.save(new Uint8Array(), "video/mp4")).rejects.toThrow();
      await expect(store.save(new Uint8Array([1]), "application/pdf")).rejects.toThrow();
      await expect(store.save(await readFile(music), "audio/wav", -1)).rejects.toThrow();
      await expect(store.save(new Uint8Array([1, 2, 3]), "video/mp4")).rejects.toThrow();
      putObject.mockResolvedValueOnce({ objectKey: "bad", byteSize: 0, checksumSha256: "bad" });
      await expect(store.save(await readFile(video), "video/mp4")).rejects.toThrow("integrity");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
