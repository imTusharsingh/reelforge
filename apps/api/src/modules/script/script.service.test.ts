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
  it("scopes reads and lifecycle writes to the authenticated workspace/editor", async () => {
    const scopedDb = {
      ...db(null),
      script: { findUnique: async () => null },
    } as unknown as Database;
    const service = new ScriptService(scopedDb, llm, new ProviderRegistry());
    await expect(service.get(context(), "foreign-script")).rejects.toThrow("Script not found");
    await expect(service.approve(context("VIEWER"), "foreign-script")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.revise(context("VIEWER"), "foreign-script", {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.providerHealth(context("VIEWER"), "provider", "llm"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("rejects a concurrent revision claim instead of creating a duplicate revision", async () => {
    const document = {
      schemaVersion: "1.0" as const,
      title: "T",
      hook: "H",
      dialogue: "D",
      cta: "C",
      metadata: { genre: "comedy", targetDurationSeconds: 1, factual: false },
      scenes: [
        {
          id: "one",
          startSeconds: 0,
          durationSeconds: 1,
          characterRefs: [],
          dialogue: "D",
          visualDescription: "V",
          camera: "wide",
          audioCues: [],
        },
      ],
    };
    const concurrentDb = {
      genre: { findFirst: async () => ({ id: "genre" }) },
      characterVersion: { findMany: async () => [] },
      script: {
        findUnique: async () => ({
          currentRevision: 1,
          status: "DRAFT",
          snapshot: { references: [] },
        }),
      },
      $transaction: async (
        callback: (tx: {
          script: { updateMany: () => Promise<{ count: number }> };
        }) => Promise<unknown>,
      ) => callback({ script: { updateMany: async () => ({ count: 0 }) } }),
    } as unknown as Database;
    const service = new ScriptService(concurrentDb, llm, new ProviderRegistry());
    await expect(service.revise(context(), "script", document)).rejects.toThrow(
      "changed concurrently",
    );
  });
});
