import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { QualityService } from "./quality.service.js";

const context: WorkspaceContext = { workspaceId: "workspace", userId: "user", role: "OWNER" };
const stored = {
  id: "review",
  renderJobId: "render",
  status: "REVIEW_REQUIRED",
  gateSummary: [],
  scorecard: null,
  policySnapshot: { mode: "MANUAL" },
  disclosures: [],
  limitations: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  supersededAt: null,
  decisions: [],
  regenerationRequests: [],
};
function fixture(): {
  service: QualityService;
  findUnique: ReturnType<typeof vi.fn<() => Promise<typeof stored | null>>>;
  findMany: ReturnType<typeof vi.fn<() => Promise<(typeof stored)[]>>>;
} {
  const findUnique = vi.fn(async () => stored as typeof stored | null);
  const findMany = vi.fn(async () => [stored]);
  const db = { qualityReviewRun: { findUnique, findMany } };
  return { service: new QualityService(db as unknown as Database), findUnique, findMany };
}
describe("legacy quality persistence compatibility", () => {
  it("rejects legacy creation without accessing persistence", async () => {
    const { service, findUnique, findMany } = fixture();
    await expect(service.create(context, { renderJobId: "render" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
  it("preserves role checks for the retired creation endpoint", async () => {
    await expect(
      fixture().service.create({ ...context, role: "VIEWER" }, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("reads persisted reviews within the workspace", async () => {
    const { service, findUnique } = fixture();
    expect(await service.get(context, "review")).toMatchObject({
      id: "review",
      status: "REVIEW_REQUIRED",
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: "workspace", id: "review" } },
      }),
    );
    findUnique.mockResolvedValueOnce(null);
    await expect(service.get(context, "other")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("queues stored reviews and rejects invalid persisted data", async () => {
    const { service, findMany, findUnique } = fixture();
    expect(await service.queue(context)).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "workspace" }) }),
    );
    findUnique.mockResolvedValueOnce({
      ...stored,
      gateSummary: [{ invalid: true }],
    } as unknown as typeof stored);
    await expect(service.get(context, "review")).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
