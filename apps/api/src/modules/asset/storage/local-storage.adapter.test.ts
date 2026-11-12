import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../asset/storage/checksum.js";
import {
  LocalFilesystemStorageAdapter,
  StoragePathError,
} from "../../asset/storage/local-storage.adapter.js";
import { StorageObjectNotFoundError } from "../../asset/storage/storage.port.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("LocalFilesystemStorageAdapter", () => {
  it("performs a real write and returns the checksum of the stored bytes", async () => {
    root = await mkdtemp(join(tmpdir(), "reelforge-storage-test-"));
    const adapter = new LocalFilesystemStorageAdapter(root);
    const body = Buffer.from("real bytes");
    const result = await adapter.putObject({
      workspaceId,
      objectKey: "assets/root/v1/file.png",
      body,
      contentType: "image/png",
    });
    expect(result.checksumSha256).toBe(sha256Hex(body));
    expect(result.byteSize).toBe(body.byteLength);
    expect(await readFile(join(root, workspaceId, "assets/root/v1/file.png"))).toEqual(body);
    expect(await adapter.getObject({ workspaceId, objectKey: "assets/root/v1/file.png" })).toEqual(
      body,
    );
    await adapter.deleteObject({ workspaceId, objectKey: "assets/root/v1/file.png" });
    await expect(
      adapter.getObject({ workspaceId, objectKey: "assets/root/v1/file.png" }),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("rejects traversal and non-UUID workspace paths", async () => {
    root = await mkdtemp(join(tmpdir(), "reelforge-storage-test-"));
    const adapter = new LocalFilesystemStorageAdapter(root);
    await expect(
      adapter.putObject({
        workspaceId,
        objectKey: "../escape.png",
        body: Buffer.from("x"),
        contentType: "image/png",
      }),
    ).rejects.toBeInstanceOf(StoragePathError);
    await expect(
      adapter.putObject({
        workspaceId: "not-a-uuid",
        objectKey: "safe.png",
        body: Buffer.from("x"),
        contentType: "image/png",
      }),
    ).rejects.toBeInstanceOf(StoragePathError);
  });
});
