import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { describe, expect, it, vi } from "vitest";
import { maxDeliveryBytes } from "../asset/content-delivery.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import type { StoragePort } from "../asset/storage/storage.port.js";
import { RunsArtifacts } from "./runs.artifacts.js";
import type { RunsStore } from "./runs.store.js";

const context = { workspaceId: randomUUID(), userId: randomUUID(), role: "OWNER" as const };
const runId = randomUUID();
const stepId = randomUUID();

describe("run artifact persistence and upgrades", () => {
  it("validates the write before touching storage, at and above the shared boundary", async () => {
    const putObject = vi.fn();
    const artifacts = new RunsArtifacts(
      { putObject, getObject: vi.fn(), deleteObject: vi.fn() },
      {} as RunsStore,
    );
    await expect(
      artifacts.put(context, "final", Buffer.alloc(maxDeliveryBytes + 1), "video/mp4"),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      artifacts.put(context, "final", Buffer.from("invalid"), "application/octet-stream"),
    ).rejects.toThrow();
    expect(putObject).not.toHaveBeenCalled();
    const saved = await artifacts.put(
      context,
      "final",
      Buffer.alloc(maxDeliveryBytes),
      "video/mp4",
    );
    expect(saved.deliveryChunkHashes).toHaveLength(512);
    expect(putObject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ objectKey: saved.objectKey }),
    );
  });

  it("cleans up a failed atomic storage write", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-artifact-test-"));
    try {
      const body = Buffer.from("offline final artifact");
      const checksum = createHash("sha256").update(body).digest("hex");
      const parent = join(root, context.workspaceId, "runs/permanent");
      // Force rename to fail after the temporary file was written.
      await mkdir(join(parent, checksum), { recursive: true });
      const artifacts = new RunsArtifacts(new LocalFilesystemStorageAdapter(root), {} as RunsStore);
      await expect(artifacts.put(context, "final", body, "video/mp4")).rejects.toThrow();
      expect(await readdir(parent)).toEqual([checksum]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves a pre-upgrade descriptor over the current write ceiling through bounded verification", async () => {
    const byteSize = maxDeliveryBytes + 1;
    const block = Buffer.alloc(256 * 1024, 0x72);
    const hash = createHash("sha256");
    for (let offset = 0; offset < byteSize; offset += block.length)
      hash.update(block.subarray(0, Math.min(byteSize - offset, block.length)));
    const checksumSha256 = hash.digest("hex");
    const legacy = {
      kind: "final",
      byteSize,
      checksumSha256,
      contentType: "video/mp4",
      objectKey: `runs/permanent/${checksumSha256}`,
      expiresAt: null,
    };
    const store = {
      get: vi.fn(),
      scoped: () => ({
        videoRunStep: {
          findFirst: vi.fn().mockResolvedValue({ output: { storageArtifacts: [legacy] } }),
        },
      }),
    } as unknown as RunsStore;
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const read = vi.fn(async (_offset: number, size: number) => {
      expect(size).toBeLessThanOrEqual(block.length);
      return block.subarray(0, size);
    });
    const storage: StoragePort = {
      putObject: vi.fn(),
      getObject: vi.fn(),
      deleteObject: vi.fn(),
      openObject: vi.fn().mockResolvedValue({ byteSize, read, close }),
    };
    const artifacts = new RunsArtifacts(storage, store);
    const [descriptor] = artifacts.descriptors({ storageArtifacts: [legacy] });
    const url = new URL(artifacts.sign(context, runId, stepId, descriptor!), "http://localhost");
    const result = await artifacts.get(
      context,
      runId,
      stepId,
      checksumSha256,
      Number(url.searchParams.get("expires")),
      url.searchParams.get("signature")!,
      { rangeHeader: "bytes=-3" },
    );
    try {
      expect(result.file).toBeDefined();
      expect(await buffer(result.file!.read())).toEqual(Buffer.from("rrr"));
      expect(read).toHaveBeenCalledTimes(513);
      expect(close).toHaveBeenCalledOnce();
      expect(storage.getObject).not.toHaveBeenCalled();
    } finally {
      await result.file?.dispose();
    }
  });
});
