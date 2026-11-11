import { describe, expect, it } from "vitest";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  contentDisposition,
  defaultContentFilename,
  deliverableMediaType,
  parseDownloadQuery,
  parsePositiveInteger,
  parseRangeHeader,
  readVerifiedStorageObject,
  sanitizeContentFilename,
} from "./content-delivery.js";
import { sha256Hex } from "./storage/checksum.js";
import { StorageObjectNotFoundError } from "./storage/storage.port.js";
import type { StoragePort, StoragePutInput, StoragePutResult } from "./storage/storage.port.js";

class StubStorage implements StoragePort {
  public body: Buffer | undefined;
  public error: Error | undefined;

  public async putObject(input: StoragePutInput): Promise<StoragePutResult> {
    this.body = input.body;
    return {
      objectKey: input.objectKey,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async getObject(): Promise<Buffer> {
    if (this.error) throw this.error;
    if (!this.body) throw new StorageObjectNotFoundError();
    return this.body;
  }

  public async deleteObject(): Promise<void> {
    this.body = undefined;
  }
}

const etag = `"sha256-${"a".repeat(64)}"`;

describe("media delivery content helpers", () => {
  it("normalizes only allowlisted persisted media types", () => {
    expect(deliverableMediaType("Video/MP4; charset=binary")).toBe("video/mp4");
    expect(deliverableMediaType("application/json")).toBe("application/json");
    expect(deliverableMediaType("text/html")).toBeUndefined();
    expect(deliverableMediaType("image/svg+xml")).toBeUndefined();
  });

  it("parses strict download and positive integer parameters", () => {
    expect(parseDownloadQuery(undefined)).toBe(false);
    expect(parseDownloadQuery("true")).toBe(true);
    expect(parseDownloadQuery("false")).toBe(false);
    expect(() => parseDownloadQuery("1")).toThrow();
    expect(parsePositiveInteger("2", "version")).toBe(2);
    expect(() => parsePositiveInteger("0", "version")).toThrow();
    expect(() => parsePositiveInteger("1.5", "version")).toThrow();
  });

  it("sanitizes filenames and builds safe content disposition headers", () => {
    expect(sanitizeContentFilename("../bad\r\nname.png", "fallback.png")).toBe("_badname.png");
    expect(sanitizeContentFilename(null, "fallback.png")).toBe("fallback.png");
    expect(defaultContentFilename("application/json", "render-manifest")).toBe(
      "render-manifest.json",
    );
    const header = contentDisposition("attachment", 'résumé "final".mp4');
    expect(header).toContain('attachment; filename="r_sum_ _final_.mp4"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.mp4");
  });

  it("supports one explicit byte range and clamps its end", () => {
    expect(parseRangeHeader(undefined, 10, etag)).toEqual({ kind: "full" });
    expect(parseRangeHeader("bytes=0-3", 10, etag)).toEqual({
      kind: "partial",
      start: 0,
      end: 3,
    });
    expect(parseRangeHeader("bytes=4-", 10, etag)).toEqual({
      kind: "partial",
      start: 4,
      end: 9,
    });
    expect(parseRangeHeader("bytes=-4", 10, etag)).toEqual({
      kind: "partial",
      start: 6,
      end: 9,
    });
    expect(parseRangeHeader("bytes=2-999", 10, etag)).toEqual({
      kind: "partial",
      start: 2,
      end: 9,
    });
  });

  it("rejects malformed, multiple, and unsatisfiable ranges", () => {
    for (const value of [
      "items=0-1",
      "bytes=0-1,3-4",
      "bytes=10-",
      "bytes=5-2",
      "bytes=-0",
      "bytes=",
      "bytes=a-b",
    ])
      expect(parseRangeHeader(value, 10, etag)).toEqual({ kind: "unsatisfiable" });
  });

  it("honors If-Range only when it matches the exact ETag", () => {
    expect(parseRangeHeader("bytes=0-1", 10, etag, etag)).toEqual({
      kind: "partial",
      start: 0,
      end: 1,
    });
    expect(parseRangeHeader("bytes=0-1", 10, etag, '"sha256-other"')).toEqual({
      kind: "full",
    });
  });

  it("verifies stored size and checksum before returning bytes", async () => {
    const storage = new StubStorage();
    const body = Buffer.from("real media bytes");
    storage.body = body;
    await expect(
      readVerifiedStorageObject({
        storage,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        objectKey: "assets/root/v1/file.mp4",
        byteSize: body.length,
        checksumSha256: sha256Hex(body),
        label: "Asset",
      }),
    ).resolves.toEqual(body);
    await expect(
      readVerifiedStorageObject({
        storage,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        objectKey: "assets/root/v1/file.mp4",
        byteSize: body.length,
        checksumSha256: "b".repeat(64),
        label: "Asset",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("distinguishes missing objects from storage failures", async () => {
    const missing = new StubStorage();
    await expect(
      readVerifiedStorageObject({
        storage: missing,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        objectKey: "missing",
        byteSize: 1,
        checksumSha256: "a".repeat(64),
        label: "Asset",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const unavailable = new StubStorage();
    unavailable.error = new Error("storage offline");
    await expect(
      readVerifiedStorageObject({
        storage: unavailable,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        objectKey: "unavailable",
        byteSize: 1,
        checksumSha256: "a".repeat(64),
        label: "Asset",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
