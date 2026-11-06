import { describe, expect, it } from "vitest";
import { ForbiddenException, ConflictException } from "@nestjs/common";
import { ProviderRegistry } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ScriptService } from "./script.service.js";
import type { ScriptLlmPort } from "./script.types.js";

const context = (role: WorkspaceContext["role"] = "EDITOR"): WorkspaceContext => ({
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  role,
});
const db = (snapshot: unknown): Database =>
  ({
    ideaApprovalSnapshot: { findUnique: async () => snapshot },
    providerBudget: { findFirst: async () => null },
  }) as unknown as Database;
const llm = {
  capability: {
    providerId: "p",
    capabilityId: "c",
    kind: "llm",
    input: ["text"],
    output: ["json"],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: 1 },
  },
  complete: async (): Promise<never> => {
    throw new Error("must not dispatch");
  },
} satisfies ScriptLlmPort;

describe("script tenant and authorization gates", () => {
  it("rejects viewers before any database/provider operation", async (): Promise<void> => {
    const service = new ScriptService(db(null), llm, new ProviderRegistry());
    await expect(
      service.generate(context("VIEWER"), {
        approvedIdeaSnapshotId: "x",
        approvedIdeaChecksum: "x",
        prompt: "x",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("rejects a foreign or missing snapshot before dispatch", async () => {
    const service = new ScriptService(db(null), llm, new ProviderRegistry());
    await expect(
      service.generate(context(), {
        approvedIdeaSnapshotId: "x",
        approvedIdeaChecksum: "x",
        prompt: "x",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
