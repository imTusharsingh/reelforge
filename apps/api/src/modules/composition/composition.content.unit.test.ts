import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConflictException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { AssetService } from "../asset/asset.service.js";
import { sha256Hex } from "../asset/storage/checksum.js";
import { StorageObjectNotFoundError } from "../asset/storage/storage.port.js";
import type {
  StoragePort,
  StoragePutInput,
  StoragePutResult,
} from "../asset/storage/storage.port.js";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import type { CompositionEnginePort } from "./composition.engine.js";
import { CompositionService } from "./composition.service.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const context: WorkspaceContext = { workspaceId, userId, role: "VIEWER" };

type ArtifactRow = Readonly<{
  id: string;
  workspaceId: string;
  renderJobId: string;
  kind: string;
  assetId: string;
  assetVersion: number;
  objectKey: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string;
  metadata: null;
  retainedUntil: Date | null;
  createdAt: Date;
}>;

type JobRow = Readonly<{
  id: string;
  workspaceId: string;
  status: string;
  expiredAt: Date | null;
  artifacts: ArtifactRow[];
}>;

type AssetRow = Readonly<{
  id: string;
  workspaceId: string;
  version: number;
  status: string;
  objectKey: string;
  mediaType: string;
  filename: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
}>;

class MemoryStorage implements StoragePort {
  public readonly objects = new Map<string, Buffer>();
  public fail = false;

  public async putObject(input: StoragePutInput): Promise<StoragePutResult> {
    this.objects.set(`${input.workspaceId}/${input.objectKey}`, Buffer.from(input.body));
    return {
      objectKey: input.objectKey,
      byteSize: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async getObject(input: { workspaceId: string; objectKey: string }): Promise<Buffer> {
    if (this.fail) throw new Error("storage offline");
    const body = this.objects.get(`${input.workspaceId}/${input.objectKey}`);
    if (!body) throw new StorageObjectNotFoundError();
    return body;
  }

  public async deleteObject(input: { workspaceId: string; objectKey: string }): Promise<void> {
    this.objects.delete(`${input.workspaceId}/${input.objectKey}`);
  }
}

class FakeRenderDb {
  public job: JobRow | undefined;
  public assetRow: AssetRow | undefined;

  public readonly renderJob = {
    findUnique: async (args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
    }): Promise<JobRow | null> => {
      const job = this.job;
      if (!job) return null;
      return job.workspaceId === args.where.workspaceId_id.workspaceId &&
        job.id === args.where.workspaceId_id.id
        ? job
        : null;
    },
  };

  public readonly asset = {
    findFirst: async (args: {
      where: {
        workspaceId: string;
        id: string;
        version: number;
        status: string;
      };
    }): Promise<AssetRow | null> => {
      const asset = this.assetRow;
      if (!asset) return null;
      return asset.workspaceId === args.where.workspaceId &&
        asset.id === args.where.id &&
        asset.version === args.where.version &&
        asset.status === args.where.status
        ? asset
        : null;
    },
  };
}

function fixture(): {
  db: FakeRenderDb;
  storage: MemoryStorage;
  jobId: string;
  artifactId: string;
  assetId: string;
  body: Buffer;
} {
  const jobId = randomUUID();
  const artifactId = randomUUID();
  const assetId = randomUUID();
  const body = Buffer.from("verified fixture video bytes");
  const checksumSha256 = sha256Hex(body);
  const objectKey = `render/${jobId}/lease/final.mp4`;
  const retainedUntil = new Date(Date.now() + 60_000);
  const artifact: ArtifactRow = {
    id: artifactId,
    workspaceId,
    renderJobId: jobId,
    kind: "VIDEO",
    assetId,
    assetVersion: 1,
    objectKey,
    mediaType: "video/mp4",
    byteSize: body.byteLength,
    checksumSha256,
    metadata: null,
    retainedUntil,
    createdAt: new Date(),
  };
  const db = new FakeRenderDb();
  db.job = {
    id: jobId,
    workspaceId,
    status: "SUCCEEDED",
    expiredAt: null,
    artifacts: [artifact],
  };
  db.assetRow = {
    id: assetId,
    workspaceId,
    version: 1,
    status: "PUBLISHED",
    objectKey,
    mediaType: "video/mp4",
    filename: "final.mp4",
    byteSize: body.byteLength,
    checksumSha256,
  };
  const storage = new MemoryStorage();
  storage.objects.set(`${workspaceId}/${objectKey}`, body);
  return { db, storage, jobId, artifactId, assetId, body };
}

function service(
  db: FakeRenderDb,
  storage: MemoryStorage,
  now: () => Date = () => new Date(),
): CompositionService {
  return new CompositionService(
    db as unknown as Database,
    {
      execute: async () => Promise.reject(new Error("engine must not run")),
    } as CompositionEnginePort,
    storage,
    {} as AssetService,
    { now },
  );
}

describe("CompositionService artifact content", () => {
  it("delivers a succeeded render artifact to a viewer with expiring cache semantics", async () => {
    const { db, storage, jobId, artifactId, body } = fixture();
    const content = await service(db, storage).getArtifactContent(context, jobId, artifactId);
    expect(content).toMatchObject({
      mediaType: "video/mp4",
      filename: "final.mp4",
      byteSize: body.byteLength,
      checksumSha256: sha256Hex(body),
      cacheControl: "private, no-store",
    });
    expect(content.body).toEqual(body);
  });

  it("does not reveal a render job from another workspace", async () => {
    const { db, storage, jobId, artifactId } = fixture();
    db.job = { ...db.job!, workspaceId: otherWorkspaceId };
    await expect(
      service(db, storage).getArtifactContent(context, jobId, artifactId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects artifacts from failed, expired, or incomplete renders", async () => {
    const failed = fixture();
    failed.db.job = { ...failed.db.job!, status: "FAILED_FINAL" };
    await expect(
      service(failed.db, failed.storage).getArtifactContent(
        context,
        failed.jobId,
        failed.artifactId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const expiredJob = fixture();
    expiredJob.db.job = { ...expiredJob.db.job!, expiredAt: new Date(Date.now() - 1) };
    await expect(
      service(expiredJob.db, expiredJob.storage).getArtifactContent(
        context,
        expiredJob.jobId,
        expiredJob.artifactId,
      ),
    ).rejects.toBeInstanceOf(GoneException);

    const expiredArtifact = fixture();
    expiredArtifact.db.job = {
      ...expiredArtifact.db.job!,
      artifacts: [
        { ...expiredArtifact.db.job!.artifacts[0]!, retainedUntil: new Date(Date.now() - 1) },
      ],
    };
    await expect(
      service(expiredArtifact.db, expiredArtifact.storage).getArtifactContent(
        context,
        expiredArtifact.jobId,
        expiredArtifact.artifactId,
      ),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it("rejects a missing artifact ID", async () => {
    const { db, storage, jobId } = fixture();
    await expect(
      service(db, storage).getArtifactContent(context, jobId, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects artifacts that are not bound to the render job or published asset", async () => {
    const foreignKey = fixture();
    foreignKey.db.job = {
      ...foreignKey.db.job!,
      artifacts: [
        {
          ...foreignKey.db.job!.artifacts[0]!,
          objectKey: "assets/other/v1/file.mp4",
        },
      ],
    };
    foreignKey.db.assetRow = {
      ...foreignKey.db.assetRow!,
      objectKey: "assets/other/v1/file.mp4",
    };
    await expect(
      service(foreignKey.db, foreignKey.storage).getArtifactContent(
        context,
        foreignKey.jobId,
        foreignKey.artifactId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const mismatched = fixture();
    mismatched.db.assetRow = {
      ...mismatched.db.assetRow!,
      checksumSha256: "b".repeat(64),
    };
    await expect(
      service(mismatched.db, mismatched.storage).getArtifactContent(
        context,
        mismatched.jobId,
        mismatched.artifactId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const unsafeType = fixture();
    unsafeType.db.job = {
      ...unsafeType.db.job!,
      artifacts: [{ ...unsafeType.db.job!.artifacts[0]!, mediaType: "text/html" }],
    };
    unsafeType.db.assetRow = { ...unsafeType.db.assetRow!, mediaType: "text/html" };
    await expect(
      service(unsafeType.db, unsafeType.storage).getArtifactContent(
        context,
        unsafeType.jobId,
        unsafeType.artifactId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("distinguishes missing, corrupt, and unavailable artifact bytes", async () => {
    const missing = fixture();
    missing.storage.objects.clear();
    await expect(
      service(missing.db, missing.storage).getArtifactContent(
        context,
        missing.jobId,
        missing.artifactId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    const corrupt = fixture();
    corrupt.storage.objects.set(
      `${workspaceId}/render/${corrupt.jobId}/lease/final.mp4`,
      Buffer.from("corrupt"),
    );
    await expect(
      service(corrupt.db, corrupt.storage).getArtifactContent(
        context,
        corrupt.jobId,
        corrupt.artifactId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const unavailable = fixture();
    unavailable.storage.fail = true;
    await expect(
      service(unavailable.db, unavailable.storage).getArtifactContent(
        context,
        unavailable.jobId,
        unavailable.artifactId,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
