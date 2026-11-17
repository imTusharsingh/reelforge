import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { SceneMediaAssignment } from "./scene-media.assignment.js";
const context: WorkspaceContext = {
  workspaceId: randomUUID(),
  userId: randomUUID(),
  role: "OWNER",
};
const body = {
  idempotencyKey: "assign-video",
  expectedJobVersion: 1,
  kind: "VIDEO",
  assetId: randomUUID(),
  assetVersion: 1,
};
function fixture(): {
  service: SceneMediaAssignment;
  tx: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  asset: Record<string, unknown>;
} {
  const asset = {
    id: body.assetId,
    version: 1,
    status: "PUBLISHED",
    mediaType: "video/mp4",
    byteSize: 64,
    checksumSha256: "a".repeat(64),
  };
  const scene = {
    id: "scene-row",
    sceneId: "one",
    ordinal: 0,
    sceneVersion: 1,
    status: "FAILED_RETRYABLE",
    sourceRefs: {},
    resolvedPrompt: "Pinned prompt",
    outputs: [
      {
        id: "old-output",
        kind: "VIDEO",
        status: "FAILED_RETRYABLE",
        assetId: null,
        assetVersion: null,
      },
    ],
  };
  const tx = {
    sceneMediaMutation: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: { data: object }) => data),
    },
    sceneMediaJob: {
      findFirst: vi.fn().mockResolvedValue({ id: "job" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sceneGeneration: {
      findFirst: vi.fn().mockResolvedValue(scene),
      findMany: vi.fn().mockResolvedValue([scene]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "new-scene", sceneVersion: 2 }),
    },
    sceneGenerationOutput: {
      create: vi.fn().mockImplementation(async ({ data }: { data: object }) => data),
    },
    asset: { findFirst: vi.fn().mockImplementation(async () => asset) },
    assetUsageReference: { create: vi.fn().mockResolvedValue({}) },
  };
  const db = {
    $transaction: async (callback: (value: typeof tx) => Promise<void>): Promise<void> =>
      callback(tx),
  } as unknown as Database;
  return { service: new SceneMediaAssignment(db), tx, asset };
}
describe("retained C3 immutable asset assignment", () => {
  it("creates a new scene/output and an idempotent mutation while preserving old media", async () => {
    const f = fixture();
    await f.service.assign(context, "job", "one", body);
    expect(f.tx.sceneGeneration!.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sceneVersion: 2, activeSlot: 1 }),
      }),
    );
    expect(f.tx.sceneGenerationOutput!.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ASSIGNED",
          assetId: body.assetId,
          assetVersion: 1,
        }),
      }),
    );
    expect(f.tx.assetUsageReference!.create).toHaveBeenCalledOnce();
    const recorded = f.tx.sceneMediaMutation!.create!.mock.calls[0]![0].data;
    f.tx.sceneMediaMutation!.findUnique!.mockResolvedValue(recorded);
    await f.service.assign(context, "job", "one", body);
    expect(f.tx.sceneGenerationOutput!.create).toHaveBeenCalledOnce();
    await expect(
      f.service.assign(context, "job", "one", { ...body, expectedJobVersion: 2 }),
    ).rejects.toThrow("reconciliation");
  });
  it("rejects missing jobs, stale versions, processing scenes and unavailable/incompatible assets", async () => {
    const absent = fixture();
    absent.tx.sceneMediaJob!.findFirst!.mockResolvedValue(null);
    await expect(absent.service.assign(context, "job", "one", body)).rejects.toThrow("not found");
    const stale = fixture();
    stale.tx.sceneMediaJob!.updateMany!.mockResolvedValue({ count: 0 });
    await expect(stale.service.assign(context, "job", "one", body)).rejects.toThrow("stale");
    const busy = fixture();
    busy.tx.sceneGeneration!.findMany!.mockResolvedValue([{ status: "PROVIDER_PROCESSING" }]);
    await expect(busy.service.assign(context, "job", "one", body)).rejects.toThrow("unresolved");
    for (const patch of [{ status: "DRAFT" }, { byteSize: 0 }, { mediaType: "image/png" }]) {
      const f = fixture();
      Object.assign(f.asset, patch);
      await expect(f.service.assign(context, "job", "one", body)).rejects.toThrow();
    }
    const missing = fixture();
    missing.tx.asset!.findFirst!.mockResolvedValue(null);
    await expect(missing.service.assign(context, "job", "one", body)).rejects.toThrow(
      "ASSET_NOT_FOUND",
    );
  });
});
