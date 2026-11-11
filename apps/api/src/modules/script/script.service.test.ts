import { randomUUID } from "node:crypto";
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
  it("rejects stale caller revisions without creating or approving unseen content", async () => {
    const document = {
      schemaVersion: "1.0" as const,
      title: "Test", hook: "Hook", dialogue: "", cta: "CTA",
      metadata: { genre: "comedy", targetDurationSeconds: 1, factual: false },
      scenes: [{
        id: "scene", startSeconds: 0, durationSeconds: 1, characterRefs: [],
        dialogue: "", visualDescription: "Visual", camera: "wide", audioCues: [],
      }],
    };
    let writes = 0;
    const staleDb = {
      genre: { findFirst: async () => ({ safetyProfile: { requiresSourceBackedClaims: false } }) },
      script: { findUnique: async () => ({
        id: "script", currentRevision: 2, status: "REVISION_PENDING",
        approvedIdeaChecksum: "checksum",
        revisions: [{ revision: 2, document }],
        snapshot: { references: [], checksumSha256: "checksum", idea: { status: "APPROVED" } },
      }), updateMany: async () => { writes++; return { count: 1 }; } },
      characterVersion: { findMany: async () => [] },
      $transaction: async () => { writes++; },
    } as unknown as Database;
    const service = new ScriptService(staleDb, llm, new ProviderRegistry());
    await expect(service.revise(context(), "script", document, 1)).rejects.toThrow(
      "Script changed since the caller",
    );
    await expect(service.approve(context(), "script", 1)).rejects.toThrow(
      "Script changed since the caller",
    );
    expect(writes).toBe(0);
  });
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
        approvedIdeaSnapshotId: randomUUID(),
        approvedIdeaChecksum: "x",
        prompt: "x",
        configSnapshotId: randomUUID(),
        promptSnapshotId: randomUUID(),
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
    await expect(service.approve(context("VIEWER"), "foreign-script", 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.revise(context("VIEWER"), "foreign-script", {}, 1)).rejects.toBeInstanceOf(
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
      genre: {
        findFirst: async () => ({
          id: "genre",
          safetyProfile: { requiresSourceBackedClaims: false },
        }),
      },
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
    await expect(service.revise(context(), "script", document, 1)).rejects.toThrow(
      "changed concurrently",
    );
  });
});

describe("malformed provider envelopes", () => {
  it.each(["missing", "null", "non-object", "null-envelope"] as const)(
    "finalizes a failed ledger when the provider returns %s metadata",
    async (envelopeKind): Promise<void> => {
      let ledgerUpsert:
        | {
            where: { workspaceId_correlationId: { correlationId: string } };
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }
        | undefined;
      const correlationId = randomUUID();
      const malformedDb = {
        ideaApprovalSnapshot: {
          findUnique: async () => ({
            id: randomUUID(),
            checksumSha256: "checksum",
            channelId: null,
            topic: "topic",
            hook: "hook",
            angle: "angle",
            references: [],
            idea: { status: "APPROVED" },
          }),
        },
        configSnapshot: { findUnique: async () => ({ id: "config", config: {} }) },
        promptBundleSnapshot: {
          findUnique: async () => ({
            id: "prompt",
            configSnapshotId: "config",
            bundle: { renderedText: "rendered prompt", fingerprintSha256: "a".repeat(64) },
            fingerprintSha256: "a".repeat(64),
          }),
        },
        providerBudget: { findFirst: async () => ({ id: "budget" }) },
        providerRequest: {
          create: async () => ({}),
          upsert: async (input: {
            where: { workspaceId_correlationId: { correlationId: string } };
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }) => {
            ledgerUpsert = input;
            return {};
          },
        },
        $transaction: async (
          callback: (tx: {
            providerRequest: { create: () => Promise<unknown> };
            $queryRaw: () => Promise<Array<{ id: string; period_start: string }>>;
            $executeRaw: () => Promise<number>;
            providerBudgetReservation: { update: () => Promise<unknown> };
          }) => Promise<unknown>,
        ) =>
          callback({
            providerRequest: { create: async () => ({}) },
            $queryRaw: async () => [{ id: "reservation", period_start: new Date().toISOString() }],
            $executeRaw: async () => 1,
            providerBudgetReservation: { update: async () => ({}) },
          }),
        $executeRaw: async () => 1,
      } as unknown as Database;
      const registry = new ProviderRegistry();
      registry.register({
        capability: llm.capability,
        credential: { providerId: "p", environment: "development", secret: "fixture-secret" },
      });
      const envelope =
        envelopeKind === "null-envelope"
          ? null
          : {
              output: {},
              ...(envelopeKind === "missing"
                ? {}
                : { metadata: envelopeKind === "null" ? null : "invalid" }),
            };
      const malformedLlm: ScriptLlmPort = {
        ...llm,
        complete: async (): Promise<Awaited<ReturnType<ScriptLlmPort["complete"]>>> =>
          envelope as unknown as Awaited<ReturnType<ScriptLlmPort["complete"]>>,
      };
      const service = new ScriptService(malformedDb, malformedLlm, registry);
      await expect(
        service.generate(context(), {
          approvedIdeaSnapshotId: randomUUID(),
          approvedIdeaChecksum: "checksum",
          prompt: "malformed envelope",
          configSnapshotId: randomUUID(),
          promptSnapshotId: randomUUID(),
          correlationId,
        }),
      ).rejects.toThrow(
        envelopeKind === "null-envelope"
          ? "Provider returned an invalid envelope"
          : "Provider returned invalid provenance",
      );
      expect(ledgerUpsert?.where.workspaceId_correlationId.correlationId).toBe(correlationId);
      expect(ledgerUpsert?.update).toMatchObject({
        channelId: null,
        status: "FAILED",
        estimatedCost: 1,
        actualCost: null,
        currency: "USD",
        dispatchedPrompt: expect.stringContaining("malformed envelope"),
        latencyMs: expect.any(Number),
        responseMetadata: { dispatched: true, costKnown: false },
      });
      expect(ledgerUpsert?.update.errorMessage).toContain(
        envelopeKind === "null-envelope" ? "invalid envelope" : "invalid provenance",
      );
      expect(ledgerUpsert?.update.errorCode).toBe("ConflictException");
    },
  );
});
