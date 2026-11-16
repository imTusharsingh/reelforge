import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "@reelforge/media";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { ProviderArtifacts } from "./provider-artifacts.js";
const video = {
  streams: [{ codec_type: "video", width: 720, height: 1280, r_frame_rate: "24/1" }],
  format: { duration: "8" },
};
function fixture(): {
  store: ProviderArtifacts;
  run: ReturnType<typeof vi.fn<ProcessRunner["run"]>>;
  putObject: ReturnType<typeof vi.fn<StoragePort["putObject"]>>;
} {
  const run = vi
    .fn<ProcessRunner["run"]>()
    .mockResolvedValue({ stdout: JSON.stringify(video), stderr: "", exitCode: 0 });
  const putObject = vi.fn<StoragePort["putObject"]>().mockImplementation(async (input) => ({
    objectKey: input.objectKey,
    byteSize: input.body.length,
    checksumSha256: createHash("sha256").update(input.body).digest("hex"),
  }));
  const storage: StoragePort = { putObject, getObject: vi.fn(), deleteObject: vi.fn() };
  return { store: new ProviderArtifacts(storage, "workspace", { run }), run, putObject };
}
describe("provider artifact boundary without native executables", () => {
  it("probes before storing, hashes the actual bytes and validates stored integrity", async () => {
    const { store, run, putObject } = fixture();
    const body = new Uint8Array([1, 2, 3]);
    const clip = await store.save(body, "video/mp4");
    expect(clip).toMatchObject({
      width: 720,
      height: 1280,
      fps: 24,
      durationSeconds: 8,
      byteSize: 3,
    });
    expect(clip.checksumSha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(clip.objectKey).toBe(`providers/${clip.checksumSha256}`);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ executable: "ffprobe", signal: expect.any(AbortSignal) }),
    );
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace", body: Buffer.from(body) }),
    );
    putObject.mockResolvedValueOnce({ objectKey: "bad", byteSize: 0, checksumSha256: "bad" });
    await expect(store.save(body, "video/mp4")).rejects.toThrow("integrity");
  });
  it("uses bounded FFmpeg arguments and stores the trimmed audio bytes", async () => {
    const { store, run, putObject } = fixture();
    run
      .mockImplementationOnce(async (input) => {
        expect(input.executable).toBe("ffmpeg");
        expect(input.argv).toContain("-nostdin");
        expect(input.argv).toContain("-t");
        expect(input.argv).toContain("5");
        await writeFile(input.argv.at(-1)!, Buffer.from("trimmed"));
        return { stdout: "", stderr: "", exitCode: 0 };
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "5" } }),
        stderr: "",
        exitCode: 0,
      });
    expect(await store.save(new Uint8Array([1, 2, 3]), "audio/wav", 5)).toMatchObject({
      mimeType: "audio/mpeg",
      durationSeconds: 5,
      width: 0,
      height: 0,
    });
    expect(putObject).toHaveBeenCalledWith(
      expect.objectContaining({ body: Buffer.from("trimmed") }),
    );
  });
  it("rejects failed processes, invalid probes and invalid input before storing", async () => {
    const { store, run, putObject } = fixture();
    const body = new Uint8Array([1]);
    await expect(store.save(new Uint8Array(), "video/mp4")).rejects.toThrow(
      "Invalid provider media",
    );
    await expect(store.save(body, "application/pdf")).rejects.toThrow("Invalid provider media");
    await expect(store.save(body, "audio/wav", -1)).rejects.toThrow("trim");
    run.mockResolvedValueOnce({ stdout: "", stderr: "failed", exitCode: 1 });
    await expect(store.save(body, "video/mp4")).rejects.toThrow("process failed");
    run.mockResolvedValueOnce({ stdout: "not-json", stderr: "", exitCode: 0 });
    await expect(store.save(body, "video/mp4")).rejects.toThrow();
    run.mockResolvedValueOnce({
      stdout: JSON.stringify({ streams: [], format: { duration: "0" } }),
      stderr: "",
      exitCode: 0,
    });
    await expect(store.save(body, "video/mp4")).rejects.toThrow("probed");
    expect(putObject).not.toHaveBeenCalled();
  });
});
