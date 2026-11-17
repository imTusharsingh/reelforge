import { describe, expect, it, vi } from "vitest";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { SceneMediaService } from "./scene-media.service.js";
import { SceneMediaHistory, legacyOutputs } from "./scene-media.history.js";
import { SceneMediaAssignment } from "./scene-media.assignment.js";
const context: WorkspaceContext = { workspaceId: "workspace", userId: "user", role: "OWNER" };
describe("V5 retires synchronous generation without losing legacy readers", () => {
  it("rejects every synchronous production entry point without provider dispatch", async () => {
    const service = new SceneMediaService({} as Database);
    await expect(service.create(context, {})).rejects.toThrow("synchronous generation was removed");
    expect(await service.capabilities(context)).toMatchObject({
      workspaceId: context.workspaceId,
      capabilities: [],
    });
    expect(await service.providerHealth(context, "provider", "video")).toMatchObject({
      healthy: false,
      reason: "LEGACY_RETIRED",
    });
  });
  it("scopes legacy reads and rejects incomplete export packages", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const service = new SceneMediaService({ sceneMediaJob: { findUnique } } as unknown as Database);
    await expect(service.get(context, "foreign-job")).rejects.toThrow("not found");
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: "foreign-job" } },
      }),
    );
    findUnique.mockResolvedValue({
      id: "job",
      workspaceId: context.workspaceId,
      schemaVersion: "2.0",
      requestedOutputs: { image: true },
      scenes: [],
    });
    await expect(service.get(context, "job")).rejects.toThrow("schema version");
    findUnique.mockResolvedValue({
      id: "job",
      workspaceId: context.workspaceId,
      schemaVersion: "1.0",
      requestedOutputs: { image: true },
      scenes: [],
      status: "FAILED",
    });
    await expect(service.exportPackage(context, "job")).rejects.toThrow("incomplete");
  });
  it("keeps tenant-scoped pagination for direct historic jobs", async () => {
    const row = {
      id: "job",
      workspaceId: context.workspaceId,
      scriptId: "script",
      scriptRevision: 1,
      channelId: null,
      status: "FAILED",
      version: 1,
      idempotencyKey: "key",
      configSnapshotId: "config",
      promptSnapshotId: "prompt",
      requestedOutputs: { image: true },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const findMany = vi.fn().mockResolvedValue([row]);
    const history = new SceneMediaHistory({ sceneMediaJob: { findMany } } as unknown as Database);
    expect(await history.list(context, {})).toMatchObject({
      items: [{ jobId: "job" }],
      page: 1,
      pageSize: 25,
      nextPage: null,
    });
    expect(findMany.mock.calls[0]![0].where.workspaceId).toBe(context.workspaceId);
    expect(legacyOutputs({ image: true, video: true })).toEqual({
      image: true,
      video: true,
      narration: false,
      dialogue: false,
    });
    for (const value of [null, [], {}, { image: false }])
      expect(() => legacyOutputs(value)).toThrow();
  });
  it("retains assignment permissions and validates pinned inputs before a transaction", async () => {
    const tx = vi.fn();
    const assignment = new SceneMediaAssignment({ $transaction: tx } as unknown as Database);
    await expect(
      assignment.assign({ ...context, role: "VIEWER" }, "job", "scene", {}),
    ).rejects.toThrow("Editor");
    await expect(assignment.assign(context, "job", "scene", {})).rejects.toThrow();
    expect(tx).not.toHaveBeenCalled();
  });
});
