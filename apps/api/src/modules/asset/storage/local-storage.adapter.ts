import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sha256Hex } from "./checksum.js";
import { StorageObjectNotFoundError } from "./storage.port.js";
import type { StoragePort, StoragePutInput, StoragePutResult } from "./storage.port.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export class StoragePathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StoragePathError";
  }
}

export function assertSafeObjectKey(objectKey: string): void {
  if (objectKey.length === 0 || objectKey.length > 512)
    throw new StoragePathError("Object key must be between 1 and 512 characters");
  if (!SAFE_OBJECT_KEY.test(objectKey))
    throw new StoragePathError("Object key contains unsupported characters");
  if (objectKey.includes("..") || objectKey.includes("\\") || objectKey.startsWith("/"))
    throw new StoragePathError("Object key must be a relative path without traversal segments");
  if (objectKey.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new StoragePathError("Object key must not contain empty or traversal segments");
}

/**
 * Real filesystem storage adapter for local development and tests. It writes
 * bytes to disk and returns the checksum computed from those bytes. It never
 * reports a successful write that did not happen.
 */
export class LocalFilesystemStorageAdapter implements StoragePort {
  private readonly root: string;

  public constructor(root: string) {
    if (root.trim().length === 0) throw new Error("A local storage root is required");
    this.root = resolve(root);
  }

  public async putObject(input: StoragePutInput): Promise<StoragePutResult> {
    if (input.body.byteLength === 0) throw new Error("Refusing to store an empty object");
    const destination = this.resolveWorkspaceObject(input.workspaceId, input.objectKey);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, input.body, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      objectKey: input.objectKey,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async getObject(input: { workspaceId: string; objectKey: string }): Promise<Buffer> {
    try {
      return await readFile(this.resolveWorkspaceObject(input.workspaceId, input.objectKey));
    } catch (error) {
      if (isMissingFile(error)) throw new StorageObjectNotFoundError();
      throw error;
    }
  }

  public async deleteObject(input: { workspaceId: string; objectKey: string }): Promise<void> {
    await rm(this.resolveWorkspaceObject(input.workspaceId, input.objectKey), { force: true });
  }

  private resolveWorkspaceObject(workspaceId: string, objectKey: string): string {
    if (!UUID_PATTERN.test(workspaceId))
      throw new StoragePathError("Workspace ID must be a UUID before it is used in a storage path");
    assertSafeObjectKey(objectKey);
    const workspaceRoot = resolve(this.root, workspaceId);
    const destination = resolve(workspaceRoot, objectKey);
    if (destination !== workspaceRoot && !destination.startsWith(`${workspaceRoot}${sep}`))
      throw new StoragePathError("Object key resolves outside the workspace storage root");
    return destination;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
