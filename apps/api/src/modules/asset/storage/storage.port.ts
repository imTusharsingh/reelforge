export const STORAGE_PORT = "STORAGE_PORT";

/**
 * A real storage adapter raises this when the requested object does not exist.
 * Callers must distinguish a missing object from a transient storage failure;
 * they must never synthesize bytes or a success response for a missing object.
 */
export class StorageObjectNotFoundError extends Error {
  public constructor(message = "Storage object not found") {
    super(message);
    this.name = "StorageObjectNotFoundError";
  }
}

export type StoragePutInput = Readonly<{
  workspaceId: string;
  objectKey: string;
  body: Buffer;
  contentType: string;
}>;

export type StoragePutResult = Readonly<{
  objectKey: string;
  byteSize: number;
  checksumSha256: string;
}>;

/**
 * Storage port for the asset library. The local adapter is the only runtime
 * adapter implemented in M04. A future S3-compatible adapter must implement the
 * same contract and must fail clearly when it cannot perform a real write.
 */
export interface StoragePort {
  putObject(input: StoragePutInput): Promise<StoragePutResult>;
  getObject(input: { workspaceId: string; objectKey: string }): Promise<Buffer>;
  deleteObject(input: { workspaceId: string; objectKey: string }): Promise<void>;
}
