import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFilesystemStorageAdapter } from "./local-storage.adapter.js";
import type { StoragePort } from "./storage.port.js";

/**
 * M04 implements the local filesystem adapter only. The architecture keeps
 * storage S3-compatible for deployed environments, but no S3 SDK is pinned on
 * main yet. Selecting an unimplemented driver fails loudly instead of silently
 * falling back to a fake success path.
 */
export function createStorageAdapter(env: NodeJS.ProcessEnv = process.env): StoragePort {
  const driver = (env.STORAGE_DRIVER ?? "local").trim().toLowerCase();
  if (driver === "local") {
    const configuredRoot = env.STORAGE_LOCAL_ROOT?.trim();
    return new LocalFilesystemStorageAdapter(
      configuredRoot && configuredRoot.length > 0
        ? configuredRoot
        : join(tmpdir(), "reelforge-storage"),
    );
  }
  throw new Error(
    `Unsupported STORAGE_DRIVER "${driver}". M04 implements only "local"; an S3-compatible adapter must be approved and added before enabling it.`,
  );
}
