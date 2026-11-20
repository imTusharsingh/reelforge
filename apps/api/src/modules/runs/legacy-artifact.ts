import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";
import { join } from "node:path";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  parseRangeHeader,
  setMediaHeaders,
  type MediaContent,
  type MediaResponseOptions,
} from "../asset/content-delivery.js";
import {
  StorageObjectNotFoundError,
  type StoragePort,
  type StorageReader,
} from "../asset/storage/storage.port.js";
import type { Artifact } from "./runs.types.js";

export type VerifiedArtifactFile = {
  read: () => ReturnType<typeof createReadStream>;
  dispose: () => Promise<void>;
};

export async function verifyLargeLegacyArtifact(
  storage: StoragePort,
  workspaceId: string,
  artifact: Artifact,
  options: MediaResponseOptions,
): Promise<VerifiedArtifactFile | undefined> {
  if (artifact.deliveryChunkHashes || !storage.openObject)
    throw new ConflictException("No streaming reader for historical artifact");
  const reader = await storage
    .openObject({ workspaceId, objectKey: artifact.objectKey })
    .catch((cause: unknown) => {
      if (cause instanceof StorageObjectNotFoundError)
        throw new NotFoundException("Artifact content is not available");
      throw new ServiceUnavailableException("Artifact storage could not be opened", { cause });
    });
  let verified: VerifiedArtifactFile | undefined;
  try {
    if (reader.byteSize !== artifact.byteSize) throw invalid();
    const range = parseRangeHeader(
      options.rangeHeader,
      artifact.byteSize,
      `"sha256-${artifact.checksumSha256}"`,
      options.ifRangeHeader,
    );
    if (options.head || range.kind === "unsatisfiable") return undefined;
    verified = await spool(
      reader,
      artifact.checksumSha256,
      range.kind === "partial" ? range.start : 0,
      range.kind === "partial" ? range.end : artifact.byteSize - 1,
      options.signal,
    );
    return verified;
  } finally {
    try {
      await reader.close();
    } catch (error) {
      await verified?.dispose();
      throw error;
    }
  }
}

const invalid = (): ConflictException =>
  new ConflictException("Artifact content failed integrity validation");

async function spool(
  reader: StorageReader,
  checksum: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<VerifiedArtifactFile> {
  const root = await mkdtemp(join(tmpdir(), "reelforge-artifact-"));
  const path = join(root, "verified");
  const dispose = (): Promise<void> => rm(root, { recursive: true, force: true });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await copyVerified(reader, handle, checksum, start, end, signal);
    } finally {
      await handle.close();
    }
    return { read: () => createReadStream(path), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function copyVerified(
  reader: StorageReader,
  handle: Awaited<ReturnType<typeof open>>,
  checksum: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<void> {
  const blockBytes = 256 * 1024;
  const hash = createHash("sha256");
  for (let offset = 0; offset < reader.byteSize; offset += blockBytes) {
    signal?.throwIfAborted();
    const length = Math.min(blockBytes, reader.byteSize - offset);
    const bytes = await reader.read(offset, length);
    if (bytes.byteLength !== length) throw invalid();
    hash.update(bytes);
    const low = Math.max(0, start - offset);
    const high = Math.min(length, end + 1 - offset);
    if (high > low) await handle.writeFile(bytes.subarray(low, high));
  }
  signal?.throwIfAborted();
  if (hash.digest("hex") !== checksum) throw invalid();
}

export async function sendLargeLegacyArtifact(
  response: Response,
  content: MediaContent,
  options: MediaResponseOptions,
  file: VerifiedArtifactFile,
): Promise<void> {
  try {
    const etag = setMediaHeaders(response, content, options);
    const range = parseRangeHeader(
      options.rangeHeader,
      content.byteSize,
      etag,
      options.ifRangeHeader,
    );
    if (range.kind === "partial") {
      response.status(206);
      response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${content.byteSize}`);
      response.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      response.status(200);
      response.setHeader("Content-Length", String(content.byteSize));
    }
    await pipeline(file.read(), response);
  } finally {
    await file.dispose();
  }
}
