import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderRegistry } from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ScriptService } from "./script.service.js";
import type { ScriptLlmPort } from "./script.types.js";

const workspaceId = randomUUID();
const snapshotId = randomUUID();
const configSnapshotId = randomUUID();
const promptSnapshotId = randomUUID();
const correlationId = randomUUID();
const context: WorkspaceContext = { workspaceId, userId: randomUUID(), role: "OWNER" };
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

type Entry = Record<string, unknown>;
function fixture(
  overrides: {
    response?: unknown;
    error?: unknown;
    prompts?: string[];
    ledger?: Entry[];
    reservations?: Entry[];
    revisions?: Entry[];
    ledgerError?: unknown;
    reserveResult?: number;
    scriptPersistError?: unknown;
  } = {},
): {
  service: ScriptService;
  db: Database;
  prompts: string[];
  ledger: Entry[];
  reservations: Entry[];
  revisions: Entry[];
} {
  const prompts = overrides.prompts ?? [];
  const ledger = overrides.ledger ?? [];
  const reservations = overrides.reservations ?? [];
  const revisions = overrides.revisions ?? [];
  const writes: Record<string, unknown> = {};
  let metadata = {
    modelVersion: "model",
    promptVersion: "prompt",
    cost: 0.2,
    currency: "USD",
    usage: { inputTokens: 4 },
  };
  const tx = {
    providerBudgetReservation: {
      update: async ({ data }: { data: Entry }): Promise<Entry> => data,
    },
    script: {
      create: async ({ data }: { data: Entry }): Promise<Entry> => {
        if (overrides.scriptPersistError) throw overrides.scriptPersistError;
        return { id: "script", ...data };
      },
    },
    scriptRevision: {
      create: async ({ data }: { data: Entry }): Promise<Entry> => {
        revisions.push(data);
        return data;
      },
    },

    $queryRaw: async (): Promise<Array<{ id: string }>> => [{ id: randomUUID() }],
    $executeRaw: async (): Promise<number> => 1,
    providerRequest: {
      create: async ({ data }: { data: Entry }): Promise<Entry> => {
        ledger.push(data);
        return data;
      },
    },
  };
  const db = {
    ideaApprovalSnapshot: {
      findUnique: async () => ({
        id: snapshotId,
        channelId: null,
        topic: "topic",
        hook: "hook",
        angle: "angle",
        references: [],
        checksumSha256: "checksum",
        idea: { status: "APPROVED" },
      }),
    },
    configSnapshot: {
      findUnique: async () => ({
        id: configSnapshotId,
        config: { identity: { audience: "snapshot audience" } },
      }),
    },
    promptBundleSnapshot: {
      findUnique: async () => ({
        id: promptSnapshotId,
        configSnapshotId,
        fingerprintSha256: "f".repeat(64),
        bundle: { renderedText: "rendered snapshot prompt", fingerprintSha256: "f".repeat(64) },
      }),
    },
    providerBudget: { findFirst: async () => ({ id: "budget" }) },
    providerRequest: {
      upsert: async ({ create, update }: { create: Entry; update: Entry }): Promise<Entry> => {
        Object.assign(writes, create, update);
        ledger.splice(0, ledger.length, writes);
        return create;
      },
      create: async ({ data }: { data: Entry }): Promise<Entry> => {
        ledger.push(data);
        return data;
      },
    },
    providerBudgetReservation: {
      create: async ({ data }: { data: Entry }): Promise<Entry> => {
        reservations.push(data);
        return data;
      },
      updateMany: async ({ data }: { data: Entry }) => {
        reservations.push({ settlement: data });
        return { count: 1 };
      },
    },
    genre: {
      findFirst: async () => ({
        id: "genre",
        safetyProfile: { requiresSourceBackedClaims: false },
      }),
    },
    characterVersion: { findMany: async () => [] },
    script: {
      findUnique: async () => ({ id: "script", revisions: [document], snapshot: {} }),
      findFirst: async () => ({ id: "script" }),
    },
    $executeRaw: async () => overrides.reserveResult ?? 1,
    $queryRaw: async () => [{ id: randomUUID() }],
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as Database;
  const llm: ScriptLlmPort = {
    capability: {
      providerId: "provider",
      capabilityId: "llm",
      kind: "llm",
      input: ["text"],
      output: ["json"],
      supportsReferenceImages: false,
      asynchronous: false,
      polling: false,
      regions: [],
      costModel: { currency: "USD", unit: "request", amount: 1 },
    },
    complete: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      if (overrides.error) throw overrides.error;
      if (
        typeof overrides.response === "object" &&
        overrides.response !== null &&
        "metadata" in overrides.response
      ) {
        metadata = (overrides.response as { metadata: typeof metadata }).metadata;
      }
      return {
        output:
          typeof overrides.response === "object" &&
          overrides.response !== null &&
          "output" in overrides.response
            ? (overrides.response as { output: unknown }).output
            : Object.prototype.hasOwnProperty.call(overrides, "response")
              ? overrides.response
              : document,
        metadata,
        providerRequestId: correlationId,
      };
    },
  };
  const registry = new ProviderRegistry();
  registry.register({
    capability: llm.capability,
    credential: { providerId: "provider", environment: "development", secret: "fixture" },
  });
  return {
    service: new ScriptService(db, llm, registry),
    db,
    prompts,
    ledger,
    reservations,
    revisions,
  };
}

const input = {
  approvedIdeaSnapshotId: snapshotId,
  approvedIdeaChecksum: "checksum",
  prompt: "caller prefix",
  configSnapshotId,
  promptSnapshotId,
};

describe("dispatch provenance and budget accounting", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "development";
  });
  it("uses the coherent snapshot prompt and config in the exact persisted dispatch prompt", async () => {
    const { service, prompts, revisions } = fixture();
    await service.generate(context, input);
    expect(prompts[0]).toContain("rendered snapshot prompt");
    expect(prompts[0]).toContain("caller prefix");
    expect(prompts[0]).toContain("snapshot audience");
    expect(prompts[0]).toContain("topic");
    expect(revisions[0]?.promptText).toBe(prompts[0]);
    expect(revisions[0]?.configSnapshotId).toBe(configSnapshotId);
  });
  it.each([
    ["provider rejection", { error: new Error("provider rejected") }],
    [
      "malformed output",
      {
        response: {
          output: { nope: true },
          metadata: { modelVersion: "model", promptVersion: "prompt", cost: null },
        },
      },
    ],
    [
      "invalid provenance",
      {
        response: {
          output: document,
          metadata: { modelVersion: "", promptVersion: "p", cost: null },
        },
      },
    ],
    [
      "persistence failure",
      {
        response: {
          output: document,
          metadata: { modelVersion: "model", promptVersion: "prompt", cost: null },
        },
        scriptPersistError: new Error("persistence failed"),
      },
    ],
  ])("records a complete ledger row after %s", async (_name, options) => {
    const { service, ledger } = fixture(options);
    await expect(service.generate(context, input)).rejects.toThrow();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      correlationId: expect.any(String),
      estimatedCost: 1,
      actualCost: null,
      currency: "USD",
      latencyMs: expect.any(Number),
      channelId: null,
      errorCode: expect.any(String),
      errorMessage: expect.any(String),
      responseMetadata: expect.objectContaining({ costKnown: false }),
    });
  });
  it("settles a success on actual cost and uses the preflight estimate for unknown actual cost", async () => {
    const known = fixture();
    await known.service.generate(context, input);
    expect(known.ledger[0]).toMatchObject({ estimatedCost: 1, actualCost: 0.2 });
    const unknown = fixture({
      response: {
        output: document,
        metadata: { modelVersion: "model", promptVersion: "prompt", cost: null, currency: "USD" },
      },
    });
    await unknown.service.generate(context, input);
    expect(unknown.ledger[0]).toMatchObject({
      estimatedCost: 1,
      actualCost: null,
      responseMetadata: expect.objectContaining({ costKnown: false }),
    });
  });
});
